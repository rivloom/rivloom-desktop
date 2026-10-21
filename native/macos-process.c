// Rivloom's macOS process boundary. This helper never accepts a PID to signal.
// The run mode must own a fresh session and sends signals only to its own group.
// Inventory contains identities, never command lines, paths or environment data.
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define MAX_PROCESSES 32768
static volatile sig_atomic_t stopping_signal = 0;
static void request_stop(int value) { (void)value; stopping_signal = 1; }
static uint64_t milliseconds(void) {
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) _exit(70);
    return (uint64_t)value.tv_sec * 1000 + (uint64_t)value.tv_nsec / 1000000;
}
static bool vanished(void) { return errno == ESRCH || errno == ENOENT; }
static int inventory_failure(const char *reason) {
    // Callers pass fixed labels only. Never disclose the observed PID or process data.
    fprintf(stderr, "RIVLOOM_PROCESS_INVENTORY_FAILURE {\"reason\":\"%s\"}\n", reason);
    return 70;
}

static int inventory(bool media) {
    // The headroom covers ordinary forks during enumeration. Filling the entire
    // buffer is ambiguous and fails rather than silently truncating the table.
    int needed = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
    if (needed <= 0) return inventory_failure("list");
    if (needed > (MAX_PROCESSES - 512) * (int)sizeof(pid_t)) return inventory_failure("capacity");
    int capacity = needed + 512 * (int)sizeof(pid_t);
    pid_t *pids = calloc(1, (size_t)capacity);
    if (!pids) return inventory_failure("allocation");
    int bytes = proc_listpids(PROC_ALL_PIDS, 0, pids, capacity);
    if (bytes >= capacity) { free(pids); return inventory_failure("capacity"); }
    if (bytes <= 0 || bytes % (int)sizeof(pid_t)) { free(pids); return inventory_failure("list"); }
    int count = 0, emitted = 0;
    if (!media) fputs("{\"schemaVersion\":1,\"processes\":[", stdout);
    for (int i = 0; i < bytes / (int)sizeof(pid_t); i++) {
        if (pids[i] == 0) continue; // The kernel task is not a userspace process.
        // SHORTBSDINFO is permitted for other users. Full birth-time information
        // is restricted to the same OS user; represent that limitation explicitly
        // rather than ignoring a known child that changes its user identity.
        struct proc_bsdshortinfo summary = {0};
        errno = 0;
        int result = proc_pidinfo(pids[i], PROC_PIDT_SHORTBSDINFO, 1, &summary, sizeof(summary));
        if (result == 0 && vanished()) continue;
        if (result != (int)sizeof(summary) || summary.pbsi_pid != (uint32_t)pids[i]) { free(pids); return inventory_failure("short-info"); }
        if (media) {
            summary.pbsi_comm[sizeof(summary.pbsi_comm) - 1] = 0;
            if (summary.pbsi_status != SZOMB && (!strcmp(summary.pbsi_comm, "ffmpeg") || !strcmp(summary.pbsi_comm, "ffprobe"))) count++;
            continue;
        }
        errno = 0;
        pid_t session = getsid(pids[i]);
        if (session < 0 && vanished()) continue;
        if (session <= 0) { free(pids); return inventory_failure("session-before"); }
        if (summary.pbsi_uid != geteuid()) {
            printf("%s{\"pid\":%u,\"parentPid\":%u,\"group\":%u,\"session\":%d,\"uid\":%u,\"created\":null,\"zombie\":%s}",
                emitted++ ? "," : "", summary.pbsi_pid, summary.pbsi_ppid, summary.pbsi_pgid,
                session, summary.pbsi_uid, summary.pbsi_status == SZOMB ? "true" : "false");
            continue;
        }
        struct proc_bsdinfo before = {0}, after = {0};
        errno = 0;
        result = proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 1, &before, sizeof(before));
        if (result == 0 && vanished()) continue;
        if (result != (int)sizeof(before) || before.pbi_pid != (uint32_t)pids[i]) { free(pids); return inventory_failure("full-info-before"); }
        if (before.pbi_start_tvsec == 0 || before.pbi_start_tvusec >= 1000000) { free(pids); return inventory_failure("birth-invalid"); }
        errno = 0;
        session = getsid(pids[i]);
        if (session < 0 && vanished()) continue;
        if (session <= 0) { free(pids); return inventory_failure("session-after"); }
        // getsid and proc_pidinfo are separate observations: never combine two
        // different incarnations of a PID into one identity.
        errno = 0;
        result = proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 1, &after, sizeof(after));
        if (result == 0 && vanished()) continue;
        if (result != (int)sizeof(after) || after.pbi_pid != (uint32_t)pids[i]) { free(pids); return inventory_failure("full-info-after"); }
        if (before.pbi_start_tvsec != after.pbi_start_tvsec || before.pbi_start_tvusec != after.pbi_start_tvusec) { free(pids); return inventory_failure("birth-changed"); }
        if (before.pbi_pgid != after.pbi_pgid) { free(pids); return inventory_failure("group-changed"); }
        if (before.pbi_uid != after.pbi_uid) { free(pids); return inventory_failure("uid-changed"); }
        printf("%s{\"pid\":%u,\"parentPid\":%u,\"group\":%u,\"session\":%d,\"uid\":%u,\"created\":\"%llu%06llu\",\"zombie\":%s}",
            emitted++ ? "," : "", after.pbi_pid, after.pbi_ppid, after.pbi_pgid, session,
            after.pbi_uid, (unsigned long long)after.pbi_start_tvsec,
            (unsigned long long)after.pbi_start_tvusec, after.pbi_status == SZOMB ? "true" : "false");
    }
    free(pids);
    if (media) printf("%d\n", count); else fputs("]}\n", stdout);
    return ferror(stdout) ? inventory_failure("output") : 0;
}

static void report(const char *event, pid_t root, int code) {
    // fd 3 is a private status pipe, closed in the engine before exec. Engine
    // stdout/stderr cannot manufacture lifecycle messages.
    if (dprintf(3, "{\"schemaVersion\":1,\"event\":\"%s\",\"groupPID\":%d,\"rootPID\":%d,\"code\":%d}\n",
        event, getpid(), root, code) < 0) stopping_signal = 1;
}

static int own_group_signal(int value) {
    if (getpgrp() != getpid() || getsid(0) != getpid()) return -1;
    return kill(0, value);
}

static int run(char **command) {
    if (!command[0] || command[0][0] != '/' || getpgrp() != getpid() || getsid(0) != getpid()) return 64;
    // Node created the private session. Keep its leader alive until group cleanup
    // so the group number cannot be reused while a shutdown signal is sent.
    signal(SIGTERM, request_stop);
    signal(SIGINT, request_stop);
    signal(SIGHUP, request_stop);
    signal(SIGPIPE, SIG_IGN);
    if (fcntl(3, F_SETFD, FD_CLOEXEC) < 0) return 70;
    int gate[2];
    if (pipe(gate) < 0) return 70;
    if (fcntl(gate[0], F_SETFD, FD_CLOEXEC) < 0 || fcntl(gate[1], F_SETFD, FD_CLOEXEC) < 0) return 70;
    pid_t root = fork();
    if (root < 0) { close(gate[0]); close(gate[1]); return 70; }
    if (root == 0) {
        close(gate[1]);
        close(3);
        signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGHUP, SIG_DFL); signal(SIGPIPE, SIG_DFL);
        char begin = 0;
        ssize_t received;
        do { received = read(gate[0], &begin, 1); } while (received < 0 && errno == EINTR);
        close(gate[0]);
        if (received != 1 || begin != 'G') _exit(70);
        int input = open("/dev/null", O_RDONLY);
        if (input < 0 || dup2(input, STDIN_FILENO) < 0) _exit(70);
        if (input > STDERR_FILENO) close(input);
        execv(command[0], command);
        _exit(127);
    }
    close(gate[0]);
    report("ready", root, 0);
    bool started = false, root_exited = false, stopping = false, input_closed = false;
    uint64_t born = milliseconds(), stop_at = 0;
    for (;;) {
        int status = 0;
        if (!root_exited) {
            pid_t result = waitpid(root, &status, WNOHANG);
            if (result == root) {
                root_exited = true;
                int code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
                report("engine-exit", root, code);
                stopping_signal = 1;
            } else if (result < 0 && errno != EINTR) stopping_signal = 1;
        }
        if (!started && milliseconds() - born >= 5000) stopping_signal = 1;
        if (stopping_signal && !stopping) {
            stopping = true; stop_at = milliseconds();
            close(gate[1]); gate[1] = -1;
            report("stopping", root, 0);
            if (own_group_signal(SIGTERM) < 0) return 70;
        }
        // The leader kills its own group atomically. There is no signal by a
        // cached external PID and no interval in which this group can be reused.
        if (stopping && milliseconds() - stop_at >= 2000) {
            if (own_group_signal(SIGKILL) < 0) return 70;
            _exit(70);
        }
        struct pollfd input = { .fd = input_closed ? -1 : STDIN_FILENO, .events = POLLIN | POLLHUP };
        int ready = poll(&input, 1, 25);
        if (ready < 0 && errno != EINTR) stopping_signal = 1;
        if (ready > 0) {
            char request[16];
            ssize_t length = read(STDIN_FILENO, request, sizeof(request));
            if (length <= 0) { stopping_signal = 1; input_closed = true; }
            for (ssize_t i = 0; i < length; i++) {
                if (request[i] == 'G' && !started && !stopping) {
                    started = true;
                    if (write(gate[1], "G", 1) != 1) stopping_signal = 1;
                    close(gate[1]); gate[1] = -1;
                } else if (request[i] == 'T') stopping_signal = 1;
                else if (request[i] == 'Q' && stopping && root_exited) return 0;
                else stopping_signal = 1;
            }
        }
    }
}

int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "snapshot")) return inventory(false);
    if (argc == 2 && !strcmp(argv[1], "media")) return inventory(true);
    if (argc >= 3 && !strcmp(argv[1], "run")) return run(argv + 2);
    return 64;
}
