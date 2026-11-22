import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const POLL_MS = 50;

/** Serializes holders of one lock within this process; the directory serializes processes. */
const inProcess = new Map<string, Promise<void>>();

/**
 * A lock shared by processes on one machine: the directory `<target>.lock`,
 * created by renaming a directory that already holds the holder's process ID,
 * so the lock never exists without an owner. A lock whose owner process is gone
 * is abandoned and taken over.
 */
export class FileLock {
  private readonly dir: string;

  constructor(target: string) {
    this.dir = `${target}.lock`;
  }

  /**
   * Acquires the lock. With `wait: false` it gives up at once when another holder
   * has it and returns undefined; otherwise it waits.
   */
  async acquire({ wait }: { wait: boolean }): Promise<(() => void) | undefined> {
    const previous = inProcess.get(this.dir);
    if (previous && !wait) return undefined;
    let releaseInProcess!: () => void;
    const mine = new Promise<void>((resolve) => (releaseInProcess = resolve));
    const chained = (previous ?? Promise.resolve()).then(() => mine);
    inProcess.set(this.dir, chained);
    await previous;

    try {
      for (;;) {
        if (this.tryCreate()) break;
        if (this.ownerIsGone()) {
          fs.rmSync(this.dir, { recursive: true, force: true });
          continue;
        }
        if (!wait) {
          this.finish(chained, releaseInProcess);
          return undefined;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    } catch (err) {
      this.finish(chained, releaseInProcess);
      throw err;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      fs.rmSync(this.dir, { recursive: true, force: true });
      this.finish(chained, releaseInProcess);
    };
  }

  private finish(chained: Promise<void>, releaseInProcess: () => void): void {
    releaseInProcess();
    if (inProcess.get(this.dir) === chained) inProcess.delete(this.dir);
  }

  private tryCreate(): boolean {
    fs.mkdirSync(path.dirname(this.dir), { recursive: true, mode: 0o700 });
    const staging = `${this.dir}.${process.pid}.${randomBytes(4).toString("hex")}`;
    fs.mkdirSync(staging, { mode: 0o700 });
    fs.writeFileSync(path.join(staging, "pid"), String(process.pid));
    try {
      fs.renameSync(staging, this.dir);
      return true;
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true });
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM") return false;
      throw err;
    }
  }

  private ownerIsGone(): boolean {
    let pid: number;
    try {
      pid = Number.parseInt(fs.readFileSync(path.join(this.dir, "pid"), "utf8"), 10);
    } catch {
      // Mid-release, or gone already: look again on the next poll.
      return false;
    }
    if (!Number.isInteger(pid) || pid === process.pid) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ESRCH";
    }
  }
}
