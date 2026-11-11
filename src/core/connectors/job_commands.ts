// The shell commands that run a detached job on its target and read it back, and their parsers. A long job is not a
// channel held open for hours: it is launched detached with one ordinary command, then advanced by ordinary polling
// commands on its monitor's cycle, so it survives an X-Monitor restart and is re-adopted by polling. Everything here
// is pure; the engine runs the strings through the monitor's transport like any other command.

import { shell_quote } from "../shell.ts";

// Marker lines separating the sections of one poll's output, so one round trip returns size, exit code, liveness and
// new output.
const size_marker = "===XMONITOR_SIZE===";
const exit_marker = "===XMONITOR_EXIT===";
const alive_marker = "===XMONITOR_ALIVE===";
const out_marker = "===XMONITOR_OUT===";

// A job's working folder on its target, named by an opaque token the monitor picks before the job has an id.
export function workdir_for(token: string): string {
  const safe = [...token].filter((character) => /[\p{L}\p{N}\-_.]/u.test(character)).join("");
  return `$HOME/.cache/x_monitor/jobs/${safe}`;
}

function folder_word(workdir: string): string {
  return workdir.startsWith("$") ? `"${workdir}"` : shell_quote(workdir);
}

// The one detached command whose stdout is the remote pid; the job's output goes to `out` and its exit code to `exit`.
export function launch_command(command: string, workdir: string): string {
  const inner = `{ ${command}; } > "$d/out" 2>&1; echo $? > "$d/exit"`;
  // The detached sh is a child process, so $d must be exported or it opens "/out" and dies before the command runs.
  return (
    `export d=${folder_word(workdir)}; mkdir -p "$d"; : > "$d/out"; rm -f "$d/exit"; ` +
    `setsid sh -c ${shell_quote(inner)} < /dev/null > /dev/null 2>&1 & ` +
    "echo $!"
  );
}

// The remote pid from launch_command's output.
export function parse_launch(stdout: string): number | null {
  const trimmed = stdout.trim();
  const line = trimmed ? trimmed.split(/\r?\n/).at(-1)!.trim() : "";
  return /^[+-]?\d+$/.test(line) ? Number(line) : null;
}

// One command returning the output's size, the exit code (empty while running), liveness, and the output past `offset`.
export function poll_command(workdir: string, pid: number, offset: number): string {
  const start = offset + 1;
  return (
    `d=${folder_word(workdir)}; ` +
    `echo ${size_marker}; wc -c < "$d/out" 2>/dev/null || echo 0; ` +
    `echo ${exit_marker}; cat "$d/exit" 2>/dev/null; ` +
    `echo ${alive_marker}; kill -0 ${Math.trunc(pid)} 2>/dev/null && echo 1 || echo 0; ` +
    `echo ${out_marker}; tail -c +${start} "$d/out" 2>/dev/null`
  );
}

export interface PollResult {
  size: number;
  exit_code: number | null;
  alive: boolean;
  // The output file past the poll's offset.
  new_output: string;
}

export function parse_poll(stdout: string): PollResult {
  const sections: Record<"size" | "exit" | "alive" | "out", string[]> = { size: [], exit: [], alive: [], out: [] };
  let current: keyof typeof sections | null = null;
  for (const line of stdout.split("\n")) {
    if (line === size_marker) current = "size";
    else if (line === exit_marker) current = "exit";
    else if (line === alive_marker) current = "alive";
    else if (line === out_marker) current = "out";
    else if (current !== null) sections[current].push(line);
  }
  const as_int = (lines: string[]): number | null => {
    const text = lines.join("").trim();
    return /^-?\d+$/.test(text) ? Number(text) : null;
  };
  // Rejoined with \n so a trailing partial line stays partial and split_lines leaves it unconsumed.
  return {
    size: as_int(sections.size) ?? 0,
    exit_code: as_int(sections.exit),
    alive: sections.alive.join("").trim() === "1",
    new_output: sections.out.join("\n"),
  };
}

// Shell that runs `command` with its stderr copied to this script's stdout line by line as it arrives, so a job's log
// shows progress while its stdout is kept apart for parsing; the file arguments are shell words, already quoted.
export function stream_stderr(command: string, status_file: string, options: { stdout_to?: string | null; keep?: string | null; prefix?: string; to_stderr?: boolean } = {}): string {
  let copy = options.keep ? `tee ${options.keep}` : "cat";
  if (options.prefix) copy += ` | while IFS= read -r line; do printf "%s%s\\n" ${shell_quote(options.prefix)} "$line"; done`;
  if (options.to_stderr) copy = `{ ${copy}; } >&2`;
  const target = options.stdout_to || "&1";
  // A subshell, so the redirects cover the whole command and an exit inside it still leaves its status behind.
  return `{ { ( ${command}\n) 2>&1 1>&3 3>&-; echo $? > ${status_file}; } | ${copy}; } 3>${target}`;
}

// Terminates the detached job, then force-kills it after a short grace.
export function cancel_command(pid: number): string {
  const number = Math.trunc(pid);
  return `kill ${number} 2>/dev/null; sleep 2; kill -9 ${number} 2>/dev/null; true`;
}

export function cleanup_command(workdir: string): string {
  return `rm -rf ${folder_word(workdir)}`;
}

// Splits a poll's new output into whole lines and the bytes they took; a trailing partial line waits for the next poll.
export function split_lines(new_output: string): [lines: string[], consumed_bytes: number] {
  if (!new_output) return [[], 0];
  const consumed = new_output.lastIndexOf("\n");
  if (consumed === -1) return [[], 0];
  const complete = new_output.slice(0, consumed);
  return [complete.split("\n"), Buffer.byteLength(complete, "utf8") + 1];
}
