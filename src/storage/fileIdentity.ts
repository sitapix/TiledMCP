import type { BigIntStats } from "node:fs";

export interface FileIdentity {
  device: string;
  inode: string;
  birthtimeNs: string;
}

export function fileIdentityOf(stats: BigIntStats): FileIdentity {
  return {
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    birthtimeNs: stats.birthtimeNs.toString(),
  };
}

export function sameFileSnapshot(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function sameFileIdentity(
  left: FileIdentity,
  right: FileIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

export function fileIdentityKey(
  identity: FileIdentity,
): string {
  return [
    identity.device,
    identity.inode,
    identity.birthtimeNs,
  ].join(":");
}
