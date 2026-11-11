import { describe, expect, it } from "vitest";

import { cmd_result } from "../../../src/core/connectors/types.ts";
import { df_command, du_command, parse_df, parse_du, path_key, PSEUDO_FS_TYPES } from "../../../src/monitors/base/disk_usage.ts";

describe("path key", () => {
  it("names the root", () => {
    expect(path_key("/")).toBe("root");
  });

  it("flattens nested paths and spaces", () => {
    expect(path_key("/mnt/my drive/")).toBe("mnt_my_drive");
  });
});

describe("df command", () => {
  it("reads one path in bytes", () => {
    expect(df_command(["size", "pcent"], { path: "/data", byte_blocks: true })).toBe("df -B1 --output=size,pcent /data");
  });

  it("shell-quotes the path", () => {
    expect(df_command(["pcent"], { path: "/it's here" }).endsWith(`'/it'"'"'s here'`)).toBe(true);
  });

  it("lists every filesystem with excludes", () => {
    expect(df_command(["target", "ipcent"], { exclude_types: ["tmpfs", "proc"] })).toBe("df -x tmpfs -x proc --output=target,ipcent");
  });

  it("counts tmpfs and overlay as pseudo types", () => {
    for (const type of ["tmpfs", "overlay", "proc"]) expect(PSEUDO_FS_TYPES).toContain(type);
  });
});

describe("parse df", () => {
  const columns = ["target", "size", "used", "pcent"];

  it("skips the header", () => {
    const block = "Mounted on 1B-blocks Used Use%\n/ 100 40 40%\n/home 200 50 25%\n";
    expect(parse_df(block, columns)).toEqual([
      { target: "/", size: 100, used: 40, pcent: 40.0 },
      { target: "/home", size: 200, used: 50, pcent: 25.0 },
    ]);
  });

  it("keeps a mount point with spaces", () => {
    expect(parse_df("hdr\n/mnt/my drive 100 10 10%\n", columns)[0].target).toBe("/mnt/my drive");
  });

  it("skips unparseable and short rows", () => {
    expect(parse_df("hdr\n/tank -\n/ 5%\ngarbage\n", ["target", "ipcent"])).toEqual([{ target: "/", ipcent: 5.0 }]);
  });

  it("reads a headerless single path", () => {
    expect(parse_df("100 40 60 40%\n", ["size", "used", "avail", "pcent"], false)).toEqual([{ size: 100, used: 40, avail: 60, pcent: 40.0 }]);
  });

  it("reads empty output as no rows", () => {
    expect(parse_df("", columns)).toEqual([]);
  });
});

describe("du", () => {
  it("builds the command", () => {
    expect(du_command("/var/log", 30)).toBe("timeout 30 du -sb /var/log");
  });

  it("reads the size", () => {
    expect(parse_du(cmd_result(0, "2048\t/var/log\n", ""), 30)).toEqual([2048, null]);
  });

  it("names a timeout", () => {
    expect(parse_du(cmd_result(124, "", ""), 30)).toEqual([null, "du timed out after 30s"]);
  });

  it("names a failure", () => {
    expect(parse_du(cmd_result(1, "", "du: cannot access\n"), 30)).toEqual([null, "du failed: du: cannot access"]);
  });

  it("names garbage output", () => {
    const [size, error] = parse_du(cmd_result(0, "", ""), 30);
    expect(size).toBeNull();
    expect(error!.startsWith("could not parse du output")).toBe(true);
  });
});
