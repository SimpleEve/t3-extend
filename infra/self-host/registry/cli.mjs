// Operator CLI behind `./t3x`: runs inside the registry container and talks to the database directly
// (root on the VPS is the administrator, so there is no request signature). Spec: research/self-host-device-keys.md Q5.
import * as NodeChildProcess from "node:child_process";

import { Store, StoreError, nowSeconds } from "./db.mjs";
import { encodeInvite } from "./invites.mjs";
import { loadConfig } from "./server.mjs";
import { normalizeDeviceName } from "./subdomain.mjs";

const { spawnSync } = NodeChildProcess;

const QR_MISSING = "二维码工具不可用，请直接复制上面的字符串";

export function renderQrWithQrencode(text) {
  const run = spawnSync("qrencode", ["-t", "ansiutf8"], { input: text, encoding: "utf8" });
  if (run.error !== undefined || run.status !== 0 || run.stdout === "") return null;
  return run.stdout;
}

const when = (seconds) =>
  seconds === null || seconds === undefined
    ? "从未"
    : new Date(seconds * 1000).toISOString().replace("T", " ").replace(/\..*/, " UTC");

function parseFlags(args, { valued = [], boolean = [] }) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (valued.includes(arg)) {
      flags[arg] = args[i + 1];
      i += 1;
    } else if (boolean.includes(arg)) {
      flags[arg] = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`未知参数 ${arg}`);
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

/** Every computer says who can see it; a phone has no such setting. */
function visibilityNote(device, devices) {
  const { mode, deviceIds } = device.visibility;
  if (device.kind !== "computer") return "";
  const names = deviceIds
    .map((id) => devices.find((d) => d.id === id)?.name ?? `已移除的设备 ${id.slice(0, 8)}`)
    .sort((a, b) => a.localeCompare(b))
    .join("、");
  switch (mode) {
    case "visible_to_all":
      return "可见性：对所有设备可见";
    case "hidden_from_all":
      return "可见性：对所有设备隐藏";
    case "hidden_from_selected":
      return `可见性：对 ${names === "" ? "（没有设备）" : names} 隐藏`;
    default:
      return `可见性：仅对 ${names === "" ? "（没有设备）" : names} 可见`;
  }
}

function findDevice(store, ref) {
  const byName = store.getDeviceByName(ref);
  if (byName !== null) return byName;
  const exact = store.getDevice(ref);
  if (exact !== null) return exact;
  const prefixed =
    ref.length >= 8 ? store.listDevices().filter((device) => device.id.startsWith(ref)) : [];
  return prefixed.length === 1 ? prefixed[0] : null;
}

const USAGE = `用法：./t3x <命令>
  invite [--kind computer|phone|any] [--no-qr]   生成一次性邀请（15 分钟内有效）
  devices                                        列出所有设备，并标出电脑设置的可见性
  revoke <名字|id>                               移除设备
  invites                                        列出还没用掉的邀请
  rename <名字> <新名字>                         改显示名（子域名不变）
  release <子域名>                               回收已移除电脑的子域名
  ntfy                                           显示手机登录推送服务器要用的账号
  info                                           显示注册表信息`;

/** Returns the process exit code. */
export function runCli(
  argv,
  {
    store,
    config,
    now = nowSeconds,
    out = console.log,
    err = console.error,
    renderQr = renderQrWithQrencode,
  },
) {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "invite": {
        const { flags } = parseFlags(args, { valued: ["--kind"], boolean: ["--no-qr"] });
        const kind = flags["--kind"] ?? "any";
        if (!["computer", "phone", "any"].includes(kind))
          throw new Error("--kind 只能是 computer、phone 或 any");
        const invite = store.createInvite({ kind, createdBy: "cli", now: now() });
        const text = encodeInvite({
          origin: config.publicOrigin,
          registryId: store.registryId,
          id: invite.id,
          secret: invite.secret,
          kind,
          expiresAt: invite.expiresAt,
        });
        out(`邀请（${when(invite.expiresAt)} 前有效，只能用一次，请当作密码传递）：`);
        out(text);
        if (flags["--no-qr"] !== true) {
          const qr = renderQr(text);
          if (qr === null) {
            err(QR_MISSING);
          } else {
            out(qr);
          }
        }
        return 0;
      }
      case "devices": {
        const devices = store.listDevices();
        if (devices.length === 0) out("还没有设备。用 ./t3x invite 生成第一个邀请。");
        for (const device of devices) {
          const seen = store.withTouches(device);
          out(
            [
              seen.name,
              seen.kind === "computer" ? "电脑" : "手机",
              seen.subdomain ?? "-",
              `最近出现 ${when(seen.lastSeenAt ?? seen.createdAt)}`,
              seen.id,
              visibilityNote(device, devices),
            ]
              .filter((part) => part !== "")
              .join("  "),
          );
        }
        return 0;
      }
      case "revoke": {
        const [ref] = args;
        if (ref === undefined) throw new Error("revoke 需要设备名或 id");
        const device = findDevice(store, ref);
        if (device === null) {
          err(`找不到设备：${ref}`);
          return 1;
        }
        const removed = store.removeDevice(device.id, now());
        out(
          `已移除 ${removed.device.name}（${removed.device.kind === "computer" ? "电脑" : "手机"}）。`,
        );
        if (removed.device.subdomain !== null) {
          out(
            `子域名 ${removed.device.subdomain} 已留墓碑，不会分给别的电脑；确实要回收时用 ./t3x release ${removed.device.subdomain}。`,
          );
          out("它的隧道最多一个心跳（约 30 秒）内断开。");
        }
        const behind = store
          .listDevices()
          .filter((d) => d.kind === "computer" && (d.lastSyncAt ?? 0) < removed.removedAt);
        for (const computer of behind)
          out(
            `注意：电脑「${computer.name}」还没同步这次移除，它重新连上服务器后才会撤销这台设备的会话（最晚 7 天）。`,
          );
        return 0;
      }
      case "invites": {
        const open = store.listOpenInvites(now());
        if (open.length === 0) out("没有待用的邀请。");
        for (const row of open)
          out(`${row.id}  ${row.kind}  创建者 ${row.created_by}  ${when(row.expires_at)} 前有效`);
        return 0;
      }
      case "rename": {
        const [ref, rawName] = args;
        const name = normalizeDeviceName(rawName);
        if (ref === undefined || name === null)
          throw new Error("用法：rename <名字> <新名字>（新名字 1–40 个字符，不含控制字符）");
        const device = findDevice(store, ref);
        if (device === null) {
          err(`找不到设备：${ref}`);
          return 1;
        }
        store.renameDevice(device.id, name);
        out(`已改名：${device.name} → ${name}`);
        return 0;
      }
      case "release": {
        const [label] = args;
        if (label === undefined) throw new Error("release 需要子域名");
        if (!store.releaseSubdomain(label)) {
          err(`${label} 不在墓碑里（要么没用过，要么还属于一台在线设备）。`);
          return 1;
        }
        out(`已回收子域名 ${label}，之后的新电脑可以拿到它。`);
        return 0;
      }
      case "info": {
        const devices = store.listDevices();
        out(`注册表 id：${store.registryId}`);
        out(`公网地址：${config.publicOrigin}`);
        out(
          `设备：${devices.filter((d) => d.kind === "computer").length} 台电脑，${devices.filter((d) => d.kind === "phone").length} 部手机`,
        );
        out(
          `待用邀请：${store.listOpenInvites(now()).length} 个；已回收前不会再分配的子域名：${store.listTombstones().length} 个`,
        );
        return 0;
      }
      case "ntfy":
        err("ntfy 的账号信息在宿主机上，请直接运行 ./t3x ntfy（由 ./t3x 脚本处理，不经过容器）。");
        return 1;
      default:
        err(USAGE);
        return command === undefined || command === "help" ? 0 : 2;
    }
  } catch (error) {
    if (error instanceof StoreError) {
      err(
        error.code === "too_many_invites"
          ? "待用的邀请已经有 20 个了，先用掉或取消一些。"
          : `失败：${error.code}`,
      );
    } else {
      err(String(error?.message ?? error));
    }
    return 1;
  }
}

if (import.meta.main) {
  const config = loadConfig();
  const store = Store.open(config.dbPath);
  const code = runCli(process.argv.slice(2), { store, config });
  store.close();
  process.exit(code);
}
