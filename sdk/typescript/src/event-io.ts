import { writeSync } from "node:fs";

/**
 * Write the full string to a file descriptor, looping over partial writes.
 *
 * `fs.writeSync` may write FEWER bytes than requested when the target is a pipe —
 * and an agent's stdout is a pipe to the runner. A single large event (e.g. a
 * `code.change.result` whose unified diff includes a regenerated
 * `package-lock.json`, easily >100KB) was being truncated mid-string, producing
 * invalid JSON that crashed the runner's NDJSON parser and failed the step with a
 * non-retryable GenericFailure. Looping until every byte is flushed — and
 * retrying `EAGAIN`/`EINTR` on a non-blocking pipe — makes event emission
 * size-safe regardless of payload length.
 */
export function writeAllSync(fd: number, data: string): void {
  const buffer = Buffer.from(data, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += writeSync(fd, buffer, offset, buffer.length - offset);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // The reader hasn't drained the pipe yet (non-blocking fd) — retry the
      // same offset rather than dropping the unwritten tail.
      if (code === "EAGAIN" || code === "EINTR") continue;
      throw error;
    }
  }
}
