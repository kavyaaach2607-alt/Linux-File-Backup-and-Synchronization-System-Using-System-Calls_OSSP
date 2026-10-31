#define _GNU_SOURCE
#pragma GCC diagnostic ignored "-Wformat-truncation"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <signal.h>
#include <time.h>
#include <poll.h>
#include <ftw.h>
#include <sys/stat.h>
#include <sys/inotify.h>

#define LOG          "backup_activity.log"
#define MAX_VERSIONS 10                         /* versions kept per file       */
#define MAX_AGE_DAYS 30                         /* delete versions older        */
#define MAX_BYTES    (500LL * 1024 * 1024)      /* size cap for versions/       */
#define DEBOUNCE     5                          /* seconds to wait after change */
#define P            4096

static FILE *lf;
static char srcRoot[P], curRoot[P], verRoot[P];
static int delMode, started;
static long copied, updated, versioned, deleted, errors;
static volatile sig_atomic_t stop;

#define EVENT(...) say(1, __VA_ARGS__)
#define ERR(...)   (errors++, say(1, "ERROR: " __VA_ARGS__))

static void say(int event, const char *fmt, ...) {
    char m[P * 2], ts[32];
    va_list a;
    va_start(a, fmt);
    vsnprintf(m, sizeof m, fmt, a);
    va_end(a);
    if (event && !started) { started = 1; say(0, "Starting backup..."); }
    time_t t = time(0);
    strftime(ts, sizeof ts, "%F %T", localtime(&t));
    printf("[%s] %s\n", ts, m); fflush(stdout);
    fprintf(lf, "[%s] %s\n", ts, m); fflush(lf);
}

static void mkpath(const char *path) {
    char t[P];
    snprintf(t, sizeof t, "%s", path);
    for (char *p = t + 1; *p; p++)
        if (*p == '/') { *p = 0; mkdir(t, 0755); *p = '/'; }
    mkdir(t, 0755);
}

static int same(const char *a, const char *b) {
    FILE *x = fopen(a, "rb"), *y = fopen(b, "rb");
    char p[8192], q[8192];
    int s = x && y;
    while (s) {
        size_t n = fread(p, 1, sizeof p, x), m = fread(q, 1, sizeof q, y);
        if (n != m || memcmp(p, q, n)) s = 0;
        if (!n) break;
    }
    if (x) fclose(x);
    if (y) fclose(y);
    return s;
}

/* copy to a temp file; source is opened first so the backup is never emptied by mistake */
static int copy(const char *s, const char *d, const struct stat *st) {
    char b[65536];
    ssize_t n = -1;
    int ok = 0, in = open(s, O_RDONLY), out = -1;
    if (in >= 0) {
        unlink(d);
        out = open(d, O_WRONLY | O_CREAT | O_TRUNC, st->st_mode & 07777);
        if (out >= 0) {
            while ((n = read(in, b, sizeof b)) > 0 && write(out, b, n) == n) ;
            ok = (n == 0);
        }
        close(in);
    }
    if (out >= 0 && close(out) != 0) ok = 0;
    if (!ok) { ERR("Copy failed: %s", s); unlink(d); return -1; }
    struct timespec t[2] = { st->st_atim, st->st_mtim };
    utimensat(AT_FDCWD, d, t, 0);
    return 0;
}

/* keep only the newest MAX_VERSIONS files in a version folder */
static void trim(const char *dir) {
    struct dirent **l;
    int n = scandir(dir, &l, 0, alphasort);
    for (int i = 0; i < n; i++) {
        char p[P];
        if (i >= 2 && i < n - MAX_VERSIONS) {
            snprintf(p, sizeof p, "%s/%s", dir, l[i]->d_name);
            if (unlink(p) == 0) say(0, "Pruned: %s (too many versions)", p);
        }
        free(l[i]);
    }
    free(l);
}

/* move the current backup copy into versions/<rel>/<timestamp>.bak */
static int archive(const char *rel, const char *cur, char *out) {
    char dir[P], ts[32];
    time_t t = time(0);
    snprintf(dir, sizeof dir, "%s%s", verRoot, rel);
    mkpath(dir);
    strftime(ts, sizeof ts, "%F_%H-%M-%S", localtime(&t));
    for (int i = 0;; i++) {
        snprintf(out, P, "%s/%s_%d.bak", dir, ts, i);
        if (access(out, F_OK)) break;
    }
    if (rename(cur, out)) { ERR("Cannot save old version of %s", cur); return -1; }
    utimensat(AT_FDCWD, out, NULL, 0);          /* version age = time it was archived */
    versioned++;
    trim(dir);
    return 0;
}

static int syncCb(const char *p, const struct stat *st, int type, struct FTW *f) {
    const char *rel = p + strlen(srcRoot);
    char c[P], t[P + 16], v[P];
    struct stat cs;
    (void)f;
    if (!*rel) return 0;
    snprintf(c, sizeof c, "%s%s", curRoot, rel);
    if (type == FTW_D) { mkdir(c, 0755); return 0; }
    if (type != FTW_F || !S_ISREG(st->st_mode)) return 0;     /* skips symlinks, pipes */

    int ex = (lstat(c, &cs) == 0);
    if (ex && !S_ISREG(cs.st_mode)) { ERR("Backup path is not a file: %s", c); return 0; }
    if (ex && st->st_size == cs.st_size) {
        if (st->st_mtim.tv_sec == cs.st_mtim.tv_sec && st->st_mtim.tv_nsec == cs.st_mtim.tv_nsec)
            return 0;                                          /* unchanged */
        if (same(p, c)) {                                      /* touched, same content */
            struct timespec ts[2] = { st->st_atim, st->st_mtim };
            utimensat(AT_FDCWD, c, ts, 0);
            return 0;
        }
    }
    snprintf(t, sizeof t, "%s.tmp", c);
    if (copy(p, t, st)) return 0;                              /* old copy untouched on failure */
    if (ex && archive(rel, c, v)) { unlink(t); return 0; }     /* old content saved first */
    if (rename(t, c)) { ERR("Cannot place %s", c); unlink(t); return 0; }
    if (ex) { updated++; EVENT("Updated: %s (previous version: %s)", p, v); }
    else    { copied++;  EVENT("Copied: %s", p); }
    return 0;
}

/* -d: anything in current/ that is gone from source moves into versions/ */
static int delCb(const char *p, const struct stat *st, int type, struct FTW *f) {
    const char *rel = p + strlen(curRoot);
    char s[P], v[P];
    struct stat x;
    (void)st; (void)f;
    if (!*rel) return 0;
    snprintf(s, sizeof s, "%s%s", srcRoot, rel);
    if (lstat(s, &x) == 0 && !!S_ISDIR(x.st_mode) == (type == FTW_DP)) return 0;
    if (type == FTW_DP) {
        if (rmdir(p) == 0) EVENT("Deleted directory: %s", p);
    } else if (type == FTW_F && !archive(rel, p, v)) {
        deleted++;
        EVENT("Deleted: %s (kept in versions: %s)", p, v);
    }
    return 0;
}

/* ---- retention: age limit, then total size cap (oldest first) ---- */
typedef struct { char *p; time_t t; off_t s; } Ver;
static Ver *vs;
static size_t nv;
static time_t now;

static int pruneCb(const char *p, const struct stat *st, int type, struct FTW *f) {
    if (type == FTW_DP) { if (f->level) rmdir(p); return 0; }  /* remove empty folders */
    if (type != FTW_F) return 0;
    if (now - st->st_mtime > MAX_AGE_DAYS * 86400L) {
        if (unlink(p) == 0) say(0, "Pruned: %s (older than %d days)", p, MAX_AGE_DAYS);
        return 0;
    }
    vs = realloc(vs, (nv + 1) * sizeof *vs);
    vs[nv++] = (Ver){ strdup(p), st->st_mtime, st->st_size };
    return 0;
}

static int byTime(const void *a, const void *b) {
    time_t x = ((const Ver *)a)->t, y = ((const Ver *)b)->t;
    return (x > y) - (x < y);
}

static void prune(void) {
    off_t total = 0;
    now = time(0);
    nv = 0;
    nftw(verRoot, pruneCb, 20, FTW_DEPTH | FTW_PHYS);
    for (size_t i = 0; i < nv; i++) total += vs[i].s;
    qsort(vs, nv, sizeof *vs, byTime);
    for (size_t i = 0; i < nv; i++) {
        if (total > MAX_BYTES && unlink(vs[i].p) == 0) {
            total -= vs[i].s;
            say(0, "Pruned: %s (size cap reached)", vs[i].p);
        }
        free(vs[i].p);
    }
    free(vs);
    vs = NULL;
    nv = 0;
}

/* ---- one backup run ---- */
static void run(int first) {
    struct stat s;
    errors = copied = updated = versioned = deleted = started = 0;
    if (first) { started = 1; say(0, "Starting backup..."); }
    if (stat(srcRoot, &s) || !S_ISDIR(s.st_mode)) {            /* never treat a missing source as "all deleted" */
        ERR("Source folder not available: %s", srcRoot);
    } else {
        nftw(srcRoot, syncCb, 20, FTW_PHYS);
        if (delMode) {
            if (first) EVENT("Checking for deleted files...");
            nftw(curRoot, delCb, 20, FTW_DEPTH | FTW_PHYS);
        }
    }
    if (started) {
        say(0, "Summary: %ld copied, %ld updated, %ld versioned, %ld deleted, %ld errors",
            copied, updated, versioned, deleted, errors);
        say(0, "Backup completed.");
        started = 0;
    }
}

/* ---- real-time watching ---- */
static int wfd;

static int watchCb(const char *p, const struct stat *st, int type, struct FTW *f) {
    (void)st; (void)f;
    if (type == FTW_D)
        inotify_add_watch(wfd, p, IN_CLOSE_WRITE | IN_CREATE | IN_DELETE | IN_MOVED_FROM | IN_MOVED_TO);
    return 0;
}

static void watch(void) {
    char b[8192];
    int dirty = 0;
    time_t last = 0, lastPrune = time(0);
    wfd = inotify_init1(IN_NONBLOCK);
    nftw(srcRoot, watchCb, 20, FTW_PHYS);
    say(0, "Watching %s (backup starts %d s after the last change)", srcRoot, DEBOUNCE);
    while (!stop) {
        struct pollfd pf = { wfd, POLLIN, 0 };
        if (poll(&pf, 1, 1000) > 0) {
            while (read(wfd, b, sizeof b) > 0) ;
            dirty = 1;
            last = time(0);
        }
        if (dirty && time(0) - last >= DEBOUNCE) {
            dirty = 0;
            run(0);
            nftw(srcRoot, watchCb, 20, FTW_PHYS);              /* watch newly created folders */
            prune();
            lastPrune = time(0);
        } else if (time(0) - lastPrune >= 3600) {
            prune();
            lastPrune = time(0);
        }
    }
    say(0, "Watcher stopped.");
}

static void onSig(int s) { (void)s; stop = 1; }

int main(int argc, char *argv[]) {
    char s[P], b[P];
    int w = 0;
    if (argc < 3) { printf("Usage: %s <source> <backup> [-d] [-w]\n", argv[0]); return 1; }
    for (int i = 3; i < argc; i++) {
        if (!strcmp(argv[i], "-d")) delMode = 1;
        else if (!strcmp(argv[i], "-w")) w = 1;
        else { printf("Unknown option: %s\n", argv[i]); return 1; }
    }
    if (!(lf = fopen(LOG, "a"))) { printf("ERROR: Cannot open %s\n", LOG); return 1; }

    mkpath(argv[2]);
    if (!realpath(argv[1], s) || !realpath(argv[2], b)) { say(0, "ERROR: source or backup folder not found"); return 1; }
    size_t n = strlen(s);
    if (!strncmp(b, s, n) && (!b[n] || b[n] == '/')) { say(0, "ERROR: backup folder must not be inside the source folder"); return 1; }
    snprintf(srcRoot, sizeof srcRoot, "%s", s);
    snprintf(curRoot, sizeof curRoot, "%s/current", b);
    snprintf(verRoot, sizeof verRoot, "%s/versions", b);
    mkpath(curRoot);
    mkpath(verRoot);

    struct sigaction sa = { .sa_handler = onSig };
    sigaction(SIGINT, &sa, 0);
    sigaction(SIGTERM, &sa, 0);

    run(1);
    prune();
    if (w) watch();
    return 0;
}
