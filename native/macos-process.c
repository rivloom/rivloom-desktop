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
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
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

static void report(const char *event, pid_t root, int code, pid_t watchdog) {
    // fd 3 is a private status pipe, closed in the engine before exec. Engine
    // stdout/stderr cannot manufacture lifecycle messages.
    if (dprintf(3, "{\"schemaVersion\":1,\"event\":\"%s\",\"groupPID\":%d,\"rootPID\":%d,\"code\":%d,\"watchdogPID\":%d}\n",
        event, getpid(), root, code, watchdog) < 0) stopping_signal = 1;
}

static int own_group_signal(int value) {
    if (getpgrp() != getpid() || getsid(0) != getpid()) return -1;
    return kill(0, value);
}

#define MAX_GUARDS 256
#define GUARD_HELPER_ENV "RIVLOOM_MACOS_PROCESS_HELPER"
#define GUARD_SOCKET_ENV "RIVLOOM_MACOS_PROCESS_SOCKET"
struct process_identity { struct proc_bsdinfo bsd; pid_t session; };
struct command_guard {
    int fd, id, stage;
    pid_t pid, root, watchdog;
    struct process_identity birth;
    bool stopping;
    char input[128];
    size_t used;
};
struct guard_broker {
    int listener, next_id;
    pid_t engine;
    struct process_identity engine_birth;
    char helper[PROC_PIDPATHINFO_MAXSIZE];
    struct command_guard guards[MAX_GUARDS];
};
static bool process_identity(pid_t pid, struct process_identity *value) {
    struct proc_bsdinfo first = {0}, last = {0};
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 1, &first, sizeof(first)) != (int)sizeof(first)) return false;
    pid_t session = getsid(pid);
    if (session <= 0 || proc_pidinfo(pid, PROC_PIDTBSDINFO, 1, &last, sizeof(last)) != (int)sizeof(last)) return false;
    if (first.pbi_pid != (uint32_t)pid || last.pbi_pid != (uint32_t)pid || first.pbi_start_tvsec == 0 ||
        first.pbi_start_tvusec >= 1000000 || first.pbi_start_tvsec != last.pbi_start_tvsec ||
        first.pbi_start_tvusec != last.pbi_start_tvusec || first.pbi_uid != last.pbi_uid ||
        first.pbi_pgid != last.pbi_pgid || first.pbi_ppid != last.pbi_ppid || last.pbi_status == SZOMB) return false;
    value->bsd = last; value->session = session;
    return true;
}
static bool same_process_identity(const struct process_identity *left, const struct process_identity *right) {
    return left->bsd.pbi_pid == right->bsd.pbi_pid && left->bsd.pbi_start_tvsec == right->bsd.pbi_start_tvsec &&
        left->bsd.pbi_start_tvusec == right->bsd.pbi_start_tvusec && left->bsd.pbi_uid == right->bsd.pbi_uid &&
        left->bsd.pbi_ppid == right->bsd.pbi_ppid && left->bsd.pbi_pgid == right->bsd.pbi_pgid && left->session == right->session;
}
static bool broker_engine_alive(const struct guard_broker *broker) {
    struct process_identity current = {0};
    return process_identity(broker->engine, &current) && same_process_identity(&broker->engine_birth, &current) &&
        current.bsd.pbi_ppid == (uint32_t)getpid() && current.bsd.pbi_uid == geteuid() &&
        current.bsd.pbi_pgid == (uint32_t)getpid() && current.session == getpid();
}
static bool write_byte(int fd, char value) {
    ssize_t length;
    do { length = write(fd, &value, 1); } while (length < 0 && errno == EINTR);
    return length == 1;
}

struct group_watchdog { pid_t pid; int writer; };
static bool close_other_descriptors(const int *keep, size_t keep_count) {
    // The native helper is single-threaded. Its descriptor table cannot grow
    // between these two reads; the kernel's estimate includes extra headroom.
    int capacity = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, NULL, 0);
    if (capacity <= 0 || capacity > 8192 * (int)sizeof(struct proc_fdinfo)) return false;
    struct proc_fdinfo *files = calloc(1, (size_t)capacity);
    if (!files) return false;
    int length = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, files, capacity);
    if (length <= 0 || length >= capacity || length % (int)sizeof(struct proc_fdinfo)) { free(files); return false; }
    for (int index = 0; index < length / (int)sizeof(struct proc_fdinfo); index++) {
        bool preserved = false;
        for (size_t position = 0; position < keep_count; position++) if (files[index].proc_fd == keep[position]) preserved = true;
        if (!preserved && files[index].proc_fd >= 0) close(files[index].proc_fd);
    }
    free(files); return true;
}
static bool watchdog_identity(pid_t group, uid_t user) {
    return group > 1 && getpgrp() == group && getsid(0) == group && geteuid() == user;
}
static bool create_watchdog(struct group_watchdog *watchdog) {
    pid_t group = getpgrp(); uid_t user = geteuid();
    if (group != getpid() || getsid(0) != group) return false;
    int life[2];
    if (pipe(life) < 0) return false;
    if (fcntl(life[0], F_SETFD, FD_CLOEXEC) < 0 || fcntl(life[1], F_SETFD, FD_CLOEXEC) < 0) {
        close(life[0]); close(life[1]); return false;
    }
    pid_t child = fork();
    if (child < 0) { close(life[0]); close(life[1]); return false; }
    if (child == 0) {
        // Only the owner keeps the write end. No target, broker connection or
        // outer lifecycle pipe may keep this watchdog alive after owner death.
        if (!close_other_descriptors(&life[0], 1)) _exit(70);
        signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN); signal(SIGHUP, SIG_IGN); signal(SIGPIPE, SIG_IGN);
        char request = 0; ssize_t length;
        do { length = read(life[0], &request, 1); } while (length < 0 && errno == EINTR);
        close(life[0]);
        if (length == 1 && request == 'Q') _exit(0);
        // This still-live member pins its current process group. It never
        // converts a historical PID/group number into an external kill target.
        if (!watchdog_identity(group, user) || kill(0, SIGTERM) < 0) _exit(70);
        uint64_t stop_at = milliseconds();
        while (milliseconds() - stop_at < 2000) (void)poll(NULL, 0, 25);
        if (!watchdog_identity(group, user)) _exit(70);
        (void)kill(0, SIGKILL); _exit(70);
    }
    close(life[0]); watchdog->pid = child; watchdog->writer = life[1];
    return true;
}
static void finish_watchdog(struct group_watchdog *watchdog) {
    (void)write_byte(watchdog->writer, 'Q');
    close(watchdog->writer); watchdog->writer = -1;
}
static bool watchdog_alive(const struct group_watchdog *watchdog) {
    int status = 0;
    pid_t result = waitpid(watchdog->pid, &status, WNOHANG);
    return result == 0 || (result < 0 && errno == EINTR);
}
static void guard_report(const char *event, struct guard_broker *broker, struct command_guard *guard, int code, const struct process_identity *birth) {
    int result;
    if (birth) result = dprintf(3, "{\"schemaVersion\":1,\"event\":\"%s\",\"groupPID\":%d,\"rootPID\":%d,\"code\":%d,\"id\":%d,\"guardPID\":%d,\"created\":\"%llu%06llu\"}\n",
        event, getpid(), broker->engine, code, guard->id, guard->pid,
        (unsigned long long)birth->bsd.pbi_start_tvsec, (unsigned long long)birth->bsd.pbi_start_tvusec);
    else result = dprintf(3, "{\"schemaVersion\":1,\"event\":\"%s\",\"groupPID\":%d,\"rootPID\":%d,\"code\":%d,\"id\":%d,\"guardPID\":%d,\"guardRootPID\":%d,\"watchdogPID\":%d}\n",
        event, getpid(), broker->engine, code, guard->id, guard->pid, guard->root, guard->watchdog);
    if (result < 0) stopping_signal = 1;
}
static bool broker_open(struct guard_broker *broker, const char *socket_path, const char *helper) {
    memset(broker, 0, sizeof(*broker)); broker->listener = -1;
    for (int index = 0; index < MAX_GUARDS; index++) broker->guards[index].fd = -1;
    if (!socket_path) return true;
    struct sockaddr_un address = { .sun_family = AF_UNIX };
    if (socket_path[0] != '/' || strlen(socket_path) >= sizeof(address.sun_path) || !realpath(helper, broker->helper)) return false;
    struct stat existing;
    if (lstat(socket_path, &existing) == 0 || errno != ENOENT) return false;
    strcpy(address.sun_path, socket_path);
    address.sun_len = (uint8_t)(offsetof(struct sockaddr_un, sun_path) + strlen(socket_path) + 1);
    int listener = socket(AF_UNIX, SOCK_STREAM, 0);
    if (listener < 0) return false;
    if (fcntl(listener, F_SETFD, FD_CLOEXEC) < 0 || fcntl(listener, F_SETFL, O_NONBLOCK) < 0 ||
        bind(listener, (struct sockaddr *)&address, address.sun_len) < 0 || chmod(socket_path, 0600) < 0 || listen(listener, MAX_GUARDS) < 0) {
        close(listener); return false;
    }
    broker->listener = listener;
    return true;
}
static void broker_close_guard(struct guard_broker *broker, struct command_guard *guard) {
    guard_report("guard-closed", broker, guard, 0, NULL);
    close(guard->fd); guard->fd = -1;
}
static bool broker_accept(struct guard_broker *broker) {
    for (int attempts = 0; attempts < MAX_GUARDS; attempts++) {
        int fd = accept(broker->listener, NULL, NULL);
        if (fd < 0) return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR;
        struct command_guard *guard = NULL;
        for (int index = 0; index < MAX_GUARDS; index++) if (broker->guards[index].fd < 0) { guard = &broker->guards[index]; break; }
        pid_t peer = 0; uid_t user = 0; gid_t group = 0; socklen_t size = sizeof(peer);
        struct process_identity before = {0}, after = {0};
        char executable[PROC_PIDPATHINFO_MAXSIZE] = {0};
        bool valid = guard && broker->next_id < 1000000 && broker_engine_alive(broker) &&
            fcntl(fd, F_SETFD, FD_CLOEXEC) == 0 && fcntl(fd, F_SETFL, O_NONBLOCK) == 0 &&
            getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &peer, &size) == 0 && size == sizeof(peer) && peer > 0 &&
            getpeereid(fd, &user, &group) == 0 && user == geteuid() && process_identity(peer, &before) &&
            before.bsd.pbi_ppid == (uint32_t)broker->engine && before.bsd.pbi_uid == geteuid() &&
            before.bsd.pbi_pgid == (uint32_t)getpid() && before.session == getpid() &&
            proc_pidpath(peer, executable, sizeof(executable)) > 0 && !strcmp(executable, broker->helper) &&
            process_identity(peer, &after) && same_process_identity(&before, &after) && broker_engine_alive(broker);
        if (!valid) { close(fd); continue; }
        memset(guard, 0, sizeof(*guard)); guard->fd = fd; guard->pid = peer; guard->id = ++broker->next_id;
        guard->birth = after;
        guard_report("guard-register", broker, guard, 0, &after);
    }
    return true;
}
static bool broker_line(struct guard_broker *broker, struct command_guard *guard, const char *line) {
    int value = -1, watchdog = -1; char tail = 0;
    if (sscanf(line, "R %d %d%c", &value, &watchdog, &tail) == 2 && value > 0 && watchdog > 0 && value != watchdog && guard->stage == 1) {
        struct process_identity leader = {0}, root = {0}, control = {0};
        if (!process_identity(guard->pid, &leader) || leader.bsd.pbi_pgid != (uint32_t)guard->pid || leader.session != guard->pid ||
            leader.bsd.pbi_start_tvsec != guard->birth.bsd.pbi_start_tvsec || leader.bsd.pbi_start_tvusec != guard->birth.bsd.pbi_start_tvusec ||
            leader.bsd.pbi_ppid != (uint32_t)broker->engine ||
            leader.bsd.pbi_uid != geteuid() || !process_identity(value, &root) || root.bsd.pbi_ppid != (uint32_t)guard->pid ||
            root.bsd.pbi_pgid != (uint32_t)guard->pid || root.session != guard->pid || root.bsd.pbi_uid != geteuid() ||
            !process_identity(watchdog, &control) || control.bsd.pbi_ppid != (uint32_t)guard->pid ||
            control.bsd.pbi_pgid != (uint32_t)guard->pid || control.session != guard->pid || control.bsd.pbi_uid != geteuid()) return false;
        guard->root = value; guard->watchdog = watchdog; guard->stage = 2;
        guard_report("guard-ready", broker, guard, 0, NULL);
        // Keep the target alive behind its gate until this live-identity check
        // finishes. A queued cancellation may clean it up after V, never exec it.
        return write_byte(guard->fd, 'V');
    }
    if (sscanf(line, "E %d%c", &value, &tail) == 1 && value >= 0 && value <= 255 && (guard->stage == 2 || guard->stage == 3)) {
        guard->stage = 4; guard_report("guard-engine-exit", broker, guard, value, NULL); return true;
    }
    if (!strcmp(line, "S") && !guard->stopping) {
        guard->stopping = true; guard_report("guard-stopping", broker, guard, 0, NULL); return true;
    }
    return false;
}
static bool broker_read(struct guard_broker *broker, struct command_guard *guard) {
    char input[128]; ssize_t length = read(guard->fd, input, sizeof(input));
    if (length == 0) { broker_close_guard(broker, guard); return true; }
    if (length < 0) return errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR;
    for (ssize_t index = 0; index < length; index++) {
        if (input[index] == '\n') {
            guard->input[guard->used] = 0;
            if (!broker_line(broker, guard, guard->input)) return false;
            guard->used = 0;
        } else {
            if (guard->used + 1 >= sizeof(guard->input) || input[index] < ' ' || input[index] > '~') return false;
            guard->input[guard->used++] = input[index];
        }
    }
    return true;
}
static bool broker_control(struct guard_broker *broker, const char *input) {
    int id = 0; char command = 0, tail = 0;
    if (sscanf(input, "%c%d%c", &command, &id, &tail) != 2 || id <= 0) return false;
    for (int index = 0; index < MAX_GUARDS; index++) {
        struct command_guard *guard = &broker->guards[index];
        if (guard->fd < 0 || guard->id != id) continue;
        if (command == 'A' && guard->stage == 0 && !guard->stopping) { guard->stage = 1; return write_byte(guard->fd, 'A'); }
        if (command == 'B' && guard->stage == 2 && !guard->stopping) { guard->stage = 3; return write_byte(guard->fd, 'G'); }
        // E proves the target was reaped. S may be delivered in the next read;
        // the host's empty-working-group proof must not race that notification.
        if (command == 'q' && guard->stage == 4) return write_byte(guard->fd, 'Q');
        // A cancellation can overtake an acknowledgement; do not revive it.
        if (guard->stopping && (command == 'A' || command == 'B' || command == 'q')) return true;
        return false;
    }
    // Closed connections cannot be revived or become a numeric signal target.
    return id <= broker->next_id;
}
static void broker_stop(struct guard_broker *broker) {
    if (broker->listener >= 0) { close(broker->listener); broker->listener = -1; }
    for (int index = 0; index < MAX_GUARDS; index++) if (broker->guards[index].fd >= 0) (void)write_byte(broker->guards[index].fd, 'T');
}

static int command_guard(int control_fd, char **command) {
    const char *socket_path = getenv(GUARD_SOCKET_ENV);
    if (!command[0] || !command[0][0] || control_fd < 3 || control_fd > 1024 || !socket_path || socket_path[0] != '/') return 64;
    struct sockaddr_un address = { .sun_family = AF_UNIX };
    if (strlen(socket_path) >= sizeof(address.sun_path) || fcntl(control_fd, F_SETFD, FD_CLOEXEC) < 0) return 64;
    strcpy(address.sun_path, socket_path);
    address.sun_len = (uint8_t)(offsetof(struct sockaddr_un, sun_path) + strlen(socket_path) + 1);
    signal(SIGTERM, request_stop); signal(SIGINT, request_stop); signal(SIGHUP, request_stop); signal(SIGPIPE, SIG_IGN);
    int connection = socket(AF_UNIX, SOCK_STREAM, 0);
    if (connection < 0 || fcntl(connection, F_SETFD, FD_CLOEXEC) < 0 || connect(connection, (struct sockaddr *)&address, address.sun_len) < 0) return 70;
    bool isolated = false, verified = false, started = false, root_exited = false, stopping = false;
    bool signalled = false, kill_requested = false, connection_closed = false, control_closed = false;
    pid_t root = 0; int gate[2] = {-1, -1}, root_code = 70;
    struct group_watchdog watchdog = { .pid = 0, .writer = -1 };
    uint64_t born = milliseconds(), stop_at = 0;
    for (;;) {
        if (watchdog.pid > 0 && !watchdog_alive(&watchdog)) stopping_signal = 1;
        if (root > 0 && !root_exited) {
            int status = 0; pid_t result = waitpid(root, &status, WNOHANG);
            if (result == root) {
                root_exited = true; root_code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
                if (dprintf(connection, "E %d\n", root_code) < 0) connection_closed = true;
                stopping_signal = 1;
            } else if (result < 0 && errno != EINTR) stopping_signal = 1;
        }
        if (!started && milliseconds() - born >= (isolated ? 5000u : 30000u)) stopping_signal = 1;
        if (stopping_signal && !stopping) {
            stopping = true; stop_at = milliseconds();
            if (!connection_closed) (void)dprintf(connection, "S\n");
            if (!isolated) return kill_requested ? 137 : 143; // No target exists before the registration ACK.
        }
        if (stopping && !signalled && (verified || connection_closed)) {
            // Before V the broker is still checking the gated target's live
            // birth identity. Queue T/K/control EOF instead of racing that
            // inspection. Losing the broker cancels immediately; it can no
            // longer grant G. The existing bounded fallback remains below.
            signalled = true;
            if (gate[1] >= 0) { close(gate[1]); gate[1] = -1; }
            if (own_group_signal(kill_requested ? SIGKILL : SIGTERM) < 0) return 70;
            if (kill_requested) _exit(137);
        }
        if (stopping && signalled && kill_requested) { (void)own_group_signal(SIGKILL); _exit(137); }
        if (stopping && milliseconds() - stop_at >= 2000) { (void)own_group_signal(SIGKILL); _exit(70); }
        struct pollfd inputs[2] = {
            { .fd = connection_closed ? -1 : connection, .events = POLLIN | POLLHUP },
            { .fd = control_closed ? -1 : control_fd, .events = POLLIN | POLLHUP }
        };
        int ready = poll(inputs, 2, 25);
        if (ready < 0 && errno != EINTR) stopping_signal = 1;
        for (int source = 0; ready > 0 && source < 2; source++) {
            if (!inputs[source].revents) continue;
            char requests[16]; ssize_t length = read(inputs[source].fd, requests, sizeof(requests));
            if (length <= 0) {
                if (source == 0) connection_closed = true; else control_closed = true;
                stopping_signal = 1; continue;
            }
            for (ssize_t index = 0; index < length; index++) {
                char request = requests[index];
                if (request == 'T') stopping_signal = 1;
                else if (request == 'K') {
                    kill_requested = true; stopping_signal = 1;
                } else if (source == 0 && request == 'A' && !isolated && !stopping && !stopping_signal) {
                    if (setsid() != getpid() || pipe(gate) < 0) return 70;
                    isolated = true; born = milliseconds();
                    if (fcntl(gate[0], F_SETFD, FD_CLOEXEC) < 0 || fcntl(gate[1], F_SETFD, FD_CLOEXEC) < 0) return 70;
                    if (!create_watchdog(&watchdog)) return 70;
                    root = fork();
                    if (root < 0) return 70;
                    if (root == 0) {
                        close(gate[1]); close(connection); close(control_fd); close(watchdog.writer);
                        signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGHUP, SIG_DFL); signal(SIGPIPE, SIG_DFL);
                        char begin = 0; ssize_t length;
                        do { length = read(gate[0], &begin, 1); } while (length < 0 && errno == EINTR);
                        close(gate[0]);
                        if (length != 1 || begin != 'G') _exit(70);
                        unsetenv(GUARD_HELPER_ENV); unsetenv(GUARD_SOCKET_ENV);
                        execvp(command[0], command); _exit(127);
                    }
                    close(gate[0]); gate[0] = -1;
                    const int private_fds[] = { connection, control_fd, gate[1], watchdog.writer };
                    if (!close_other_descriptors(private_fds, sizeof(private_fds) / sizeof(private_fds[0]))) return 70;
                    if (dprintf(connection, "R %d %d\n", root, watchdog.pid) < 0) stopping_signal = 1;
                } else if (source == 0 && request == 'V' && isolated && !verified) {
                    verified = true;
                } else if (source == 0 && request == 'G' && isolated && !started && !stopping && !stopping_signal) {
                    if (!verified) return 70;
                    started = true;
                    if (!write_byte(gate[1], 'G')) stopping_signal = 1;
                    close(gate[1]); gate[1] = -1;
                } else if (source == 0 && request == 'Q' && stopping && root_exited) { finish_watchdog(&watchdog); return root_code; }
                else stopping_signal = 1;
            }
        }
    }
}

static int run(char **command, const char *socket_path, const char *helper) {
    if (!command[0] || command[0][0] != '/' || getpgrp() != getpid() || getsid(0) != getpid()) return 64;
    // Node created the private session. Keep its leader alive until group cleanup
    // so the group number cannot be reused while a shutdown signal is sent.
    signal(SIGTERM, request_stop);
    signal(SIGINT, request_stop);
    signal(SIGHUP, request_stop);
    signal(SIGPIPE, SIG_IGN);
    if (fcntl(3, F_SETFD, FD_CLOEXEC) < 0) return 70;
    struct guard_broker broker;
    if (!broker_open(&broker, socket_path, helper)) return 70;
    int gate[2];
    if (pipe(gate) < 0) return 70;
    if (fcntl(gate[0], F_SETFD, FD_CLOEXEC) < 0 || fcntl(gate[1], F_SETFD, FD_CLOEXEC) < 0) return 70;
    struct group_watchdog watchdog = { .pid = 0, .writer = -1 };
    if (!create_watchdog(&watchdog)) return 70;
    pid_t root = fork();
    if (root < 0) { close(gate[0]); close(gate[1]); return 70; }
    if (root == 0) {
        close(gate[1]);
        close(3);
        close(watchdog.writer);
        if (broker.listener >= 0) close(broker.listener);
        signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGHUP, SIG_DFL); signal(SIGPIPE, SIG_DFL);
        char begin = 0;
        ssize_t received;
        do { received = read(gate[0], &begin, 1); } while (received < 0 && errno == EINTR);
        close(gate[0]);
        if (received != 1 || begin != 'G') _exit(70);
        int input = open("/dev/null", O_RDONLY);
        if (input < 0 || dup2(input, STDIN_FILENO) < 0) _exit(70);
        if (input > STDERR_FILENO) close(input);
        if (socket_path && (setenv(GUARD_HELPER_ENV, broker.helper, 1) < 0 || setenv(GUARD_SOCKET_ENV, socket_path, 1) < 0)) _exit(70);
        execv(command[0], command);
        _exit(127);
    }
    close(gate[0]);
    broker.engine = root;
    if (!process_identity(root, &broker.engine_birth) || !broker_engine_alive(&broker)) return 70;
    report("ready", root, 0, watchdog.pid);
    bool started = false, root_exited = false, stopping = false, input_closed = false;
    uint64_t born = milliseconds(), stop_at = 0;
    char broker_command[32] = {0}; size_t broker_command_used = 0;
    for (;;) {
        if (!watchdog_alive(&watchdog)) stopping_signal = 1;
        int status = 0;
        if (!root_exited) {
            pid_t result = waitpid(root, &status, WNOHANG);
            if (result == root) {
                root_exited = true;
                int code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
                report("engine-exit", root, code, watchdog.pid);
                stopping_signal = 1;
            } else if (result < 0 && errno != EINTR) stopping_signal = 1;
        }
        if (!started && milliseconds() - born >= 5000) stopping_signal = 1;
        if (stopping_signal && !stopping) {
            stopping = true; stop_at = milliseconds();
            close(gate[1]); gate[1] = -1;
            report("stopping", root, 0, watchdog.pid);
            broker_stop(&broker);
            if (own_group_signal(SIGTERM) < 0) return 70;
        }
        // The leader kills its own group atomically. There is no signal by a
        // cached external PID and no interval in which this group can be reused.
        if (stopping && milliseconds() - stop_at >= 2000) {
            if (own_group_signal(SIGKILL) < 0) return 70;
            _exit(70);
        }
        struct pollfd inputs[MAX_GUARDS + 2];
        inputs[0] = (struct pollfd){ .fd = input_closed ? -1 : STDIN_FILENO, .events = POLLIN | POLLHUP };
        inputs[1] = (struct pollfd){ .fd = broker.listener, .events = POLLIN };
        for (int index = 0; index < MAX_GUARDS; index++) inputs[index + 2] = (struct pollfd){ .fd = broker.guards[index].fd, .events = POLLIN | POLLHUP };
        int ready = poll(inputs, MAX_GUARDS + 2, 25);
        if (ready < 0 && errno != EINTR) stopping_signal = 1;
        if (ready > 0 && inputs[1].revents && !broker_accept(&broker)) stopping_signal = 1;
        for (int index = 0; ready > 0 && index < MAX_GUARDS; index++)
            if (inputs[index + 2].revents && !broker_read(&broker, &broker.guards[index])) stopping_signal = 1;
        if (ready > 0 && inputs[0].revents) {
            char request[16];
            ssize_t length = read(STDIN_FILENO, request, sizeof(request));
            if (length <= 0) { stopping_signal = 1; input_closed = true; }
            for (ssize_t i = 0; i < length; i++) {
                if (broker_command_used || request[i] == 'A' || request[i] == 'B' || request[i] == 'q') {
                    if (request[i] == '\n') {
                        broker_command[broker_command_used] = 0;
                        if (!broker_control(&broker, broker_command)) stopping_signal = 1;
                        broker_command_used = 0;
                    } else if (broker_command_used + 1 < sizeof(broker_command)) broker_command[broker_command_used++] = request[i];
                    else stopping_signal = 1;
                } else if (request[i] == 'G' && !started && !stopping) {
                    started = true;
                    if (write(gate[1], "G", 1) != 1) stopping_signal = 1;
                    close(gate[1]); gate[1] = -1;
                } else if (request[i] == 'T') stopping_signal = 1;
                else if (request[i] == 'Q' && stopping && root_exited) { finish_watchdog(&watchdog); return 0; }
                else stopping_signal = 1;
            }
        }
    }
}

int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "snapshot")) return inventory(false);
    if (argc == 2 && !strcmp(argv[1], "media")) return inventory(true);
    if (argc >= 6 && !strcmp(argv[1], "guard") && !strcmp(argv[2], "--control-fd") && !strcmp(argv[4], "--")) {
        char *end = NULL; long fd = strtol(argv[3], &end, 10);
        if (!end || *end || fd < 3 || fd > 1024) return 64;
        return command_guard((int)fd, argv + 5);
    }
    if (argc >= 6 && !strcmp(argv[1], "run") && !strcmp(argv[2], "--socket") && !strcmp(argv[4], "--")) return run(argv + 5, argv[3], argv[0]);
    if (argc >= 3 && !strcmp(argv[1], "run")) return run(argv + 2, NULL, argv[0]);
    return 64;
}
