import { Router, type IRouter } from "express";
import {
  db as pgDb,
  vouchersTable,
  rewardCardsTable,
  usersTable,
  chargeRequestsTable,
} from "@workspace/db";
import { eq, sql, desc, and } from "drizzle-orm";
import { RouterOSClient } from "routeros-client";
import { Client as SshClient } from "ssh2";

const router: IRouter = Router();

function checkAdmin(req: any, res: any): boolean {
  const adminCode = process.env.ADMIN_CODE || "admin1234";
  const provided = req.body?.adminCode || req.query?.adminCode;
  if (provided !== adminCode) {
    res.status(403).json({ error: "❌ كود الإدارة غير صحيح" });
    return false;
  }
  return true;
}

function withT<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, r) =>
      setTimeout(() => r(new Error(`timeout ${ms}ms`)), ms),
    ),
  ]);
}

function isDuplicateCard(e: any): boolean {
  return (
    e?.code === "23505" ||
    e?.cause?.code === "23505" ||
    String(e?.message).includes("23505") ||
    String(e?.message).toLowerCase().includes("unique") ||
    String(e?.message).toLowerCase().includes("duplicate")
  );
}

// User Manager HTTP automation (Echo2 session-based)
async function usermanAssignProfile(
  host: string,
  port: number,
  authUser: string,
  authPass: string,
  username: string,
  profile: string,
): Promise<boolean> {
  const base = `http://${host}:${port}/userman`;
  const creds = Buffer.from(`${authUser}:${authPass}`).toString("base64");
  const basicAuth = `Basic ${creds}`;

  // الخطوة 1: GET لتهيئة الجلسة والحصول على MWTSESSION cookie
  const initResp = await withT(
    fetch(`${base}/`, {
      headers: { Authorization: basicAuth },
      redirect: "follow",
    }),
    6000,
  );
  const rawCookies = initResp.headers.get("set-cookie") || "";
  const mwtSession = rawCookies.match(/MWTSESSION=([^;]+)/)?.[1];
  if (!mwtSession)
    throw new Error(`No MWTSESSION cookie. Status=${initResp.status}`);
  const cookieHeader = `MWTSESSION=${mwtSession}`;
  console.info(`[Admin] Got MWTSESSION=${mwtSession.slice(0, 12)}...`);

  // الخطوة 2: POST إلى userProfile/create مع cookie والبيانات الصحيحة
  // نجرب صيغ متعددة لمعرفة الحقل الصحيح
  const forms = [
    `user=${encodeURIComponent(username)}&profile=${encodeURIComponent(profile)}&customer=admin&action=create`,
    `username=${encodeURIComponent(username)}&profile=${encodeURIComponent(profile)}&customer=admin&action=create`,
    `user=${encodeURIComponent(username)}&profile=${encodeURIComponent(profile)}&customer=admin`,
    `user=${encodeURIComponent(username)}&profiles=${encodeURIComponent(profile)}&customer=admin`,
  ];

  for (const body of forms) {
    for (const path of [
      `${base}/userProfile/create`,
      `${base}/user-profile/create`,
      `${base}/create`,
    ]) {
      try {
        const resp = await withT(
          fetch(path, {
            method: "POST",
            headers: {
              Authorization: basicAuth,
              Cookie: cookieHeader,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body,
            redirect: "follow",
          }),
          5000,
        );
        const text = await resp.text().catch(() => "");
        // نتحقق من الرد — إذا ذكر البروفايل أو "success" فالعملية نجحت
        const hasProfile =
          text.includes(profile.replace(/\+/g, "%2B")) ||
          text.includes(profile);
        const hasError =
          text.toLowerCase().includes("error") ||
          text.toLowerCase().includes("invalid");
        console.info(
          `[Admin] POST ${path} [${body.slice(0, 30)}]: status=${resp.status} hasProfile=${hasProfile} hasError=${hasError} body=${text.slice(0, 120)}`,
        );
        if (hasProfile && !hasError) return true;
      } catch (e: any) {
        console.info(`[Admin] POST ${path} failed: ${e?.message}`);
      }
    }
  }

  // الخطوة 3: Echo2 Synchronize — نرسل رسالة XML بسيطة
  const initXml = `<?xml version="1.0"?><message><messagepart processor="EchoClientAnalyzer"><property type="boolean" name="navigatorCookieEnabled" value="true"/><property type="string" name="navigatorUserAgent" value="Mozilla/5.0"/><property type="string" name="navigatorPlatform" value="Linux"/><property type="integer" name="screenWidth" value="1280"/><property type="integer" name="screenHeight" value="720"/><property type="integer" name="screenColorDepth" value="24"/><property type="integer" name="utcOffset" value="0"/></messagepart></message>`;

  const syncResp = await withT(
    fetch(`${base}/?serviceId=Echo.Synchronize`, {
      method: "POST",
      headers: {
        Authorization: basicAuth,
        Cookie: cookieHeader,
        "Content-Type": "text/xml",
      },
      body: initXml,
    }),
    6000,
  );
  const syncText = await syncResp.text().catch(() => "");
  console.info(
    `[Admin] Echo.Synchronize status=${syncResp.status} body=${syncText.slice(0, 300)}`,
  );

  return false;
}

// SSH → RouterOS CLI لتعيين البروفايل
// خوارزميات SSH المتوافقة مع RouterOS 6.x
const ROS6_ALGORITHMS = {
  kex: [
    "diffie-hellman-group14-sha1",
    "diffie-hellman-group1-sha1",
    "ecdh-sha2-nistp256",
    "ecdh-sha2-nistp384",
    "ecdh-sha2-nistp521",
  ] as string[],
  serverHostKey: ["ssh-rsa", "ssh-dss"] as string[],
  cipher: [
    "aes128-cbc",
    "aes256-cbc",
    "3des-cbc",
    "aes128-ctr",
    "aes256-ctr",
    "aes192-ctr",
  ] as string[],
  hmac: ["hmac-sha1", "hmac-md5", "hmac-sha2-256"] as string[],
};

// تنفيذ أمر واحد أو عدة أوامر عبر SSH في session واحد
function sshExecCommands(
  host: string,
  sshUser: string,
  sshPass: string,
  commands: string[],
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    const results: string[] = [];
    let timer: ReturnType<typeof setTimeout>;

    const runNext = (idx: number) => {
      if (idx >= commands.length) {
        clearTimeout(timer);
        conn.end();
        return resolve(results);
      }
      let out = "";
      conn.exec(commands[idx], (err, stream) => {
        if (err) {
          clearTimeout(timer);
          conn.end();
          return reject(err);
        }
        stream.on("data", (d: Buffer) => {
          out += d.toString();
        });
        stream.stderr.on("data", (d: Buffer) => {
          out += d.toString();
        });
        stream.on("close", (code: number) => {
          // ignore exit code — RouterOS sometimes returns 1 even on success
          results.push(out.trim());
          runNext(idx + 1);
        });
      });
    };

    conn.on("ready", () => {
      timer = setTimeout(() => {
        conn.end();
        reject(new Error("SSH session timeout"));
      }, 20000);
      runNext(0);
    });

    conn.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });

    conn.connect({
      host,
      port: 22,
      username: sshUser,
      password: sshPass,
      readyTimeout: 15000,
      algorithms: ROS6_ALGORITHMS,
      hostVerifier: () => true,
    });
  });
}

// إسناد البروفايل فقط (للتوافق مع الكود القديم)
async function sshAssignProfile(
  host: string,
  sshUser: string,
  sshPass: string,
  username: string,
  profile: string,
): Promise<string> {
  const results = await sshExecCommands(host, sshUser, sshPass, [
    `/tool user-manager user-profile add profile="${profile}" user="${username}"`,
  ]);
  return results[0] ?? "";
}

function getMikrotikClient(
  urlEnv = "MIKROTIK_URL",
  userEnv = "MIKROTIK_USER",
  passEnv = "MIKROTIK_PASS",
) {
  const rawUrl = process.env[urlEnv] || "";
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    return new RouterOSClient({
      host: u.hostname,
      port: u.port ? parseInt(u.port, 10) : 8728,
      user: process.env[userEnv] || "admin",
      password: process.env[passEnv] || "",
      timeout: 120,
    });
  } catch {
    return null;
  }
}

function getMikrotikClient2() {
  return getMikrotikClient("MIKROTIK_URL2", "MIKROTIK_USER2", "MIKROTIK_PASS2");
}

// استخراج معلومات الراوتر من اتصال قائم
async function fetchRouterInfo(conn: any): Promise<Record<string, any>> {
  const info: Record<string, any> = {};

  try {
    const identity = (await withT(
      conn.menu("/system/identity").get(),
      5000,
    )) as any[];
    info.name = identity?.[0]?.name ?? "مجهول";
  } catch {
    info.name = "—";
  }

  try {
    const resource = (await withT(
      conn.menu("/system/resource").get(),
      5000,
    )) as any[];
    const r = resource?.[0] || {};
    info.cpu = parseInt(r["cpu-load"] ?? "0", 10);
    info.uptime = r.uptime ?? "—";
    info.version = r.version ?? "—";
    info.totalMem = parseInt(r["total-memory"] ?? "0", 10);
    info.freeMem = parseInt(r["free-memory"] ?? "0", 10);
  } catch {
    info.cpu = null;
    info.uptime = "—";
  }

  try {
    const active = (await withT(
      conn.menu("/ip/hotspot/active").get(),
      5000,
    )) as any[];
    info.hotspotActive = active.length;
    info.activeHosts = active.map((a: any) => ({
      ip: a.address ?? a["user-ip"] ?? "—",
      mac: a["mac-address"] ?? "—",
      user: a.user ?? "—",
      uptime: a.uptime ?? "—",
    }));
  } catch {
    info.hotspotActive = null;
    info.activeHosts = [];
  }

  try {
    const hosts = (await withT(
      conn.menu("/ip/hotspot/host").get(),
      5000,
    )) as any[];
    info.hotspotHosts = hosts.length;
    const activeMacs = new Set((info.activeHosts || []).map((h: any) => h.mac));
    info.hostList = hosts.map((h: any) => {
      const mac = h["mac-address"] ?? "—";
      return {
        ip: h.address ?? "—",
        mac,
        status: activeMacs.has(mac) ? "active" : "inactive",
        comment: h.comment ?? "",
      };
    });
  } catch {
    info.hotspotHosts = null;
    info.hostList = [];
  }

  try {
    const neighbors = (await withT(
      conn.menu("/ip/neighbor").get(),
      5000,
    )) as any[];
    info.neighborCount = neighbors.length;
    info.neighbors = neighbors.slice(0, 20).map((n: any) => ({
      identity: n.identity ?? n["system-description"] ?? "—",
      address: n.address ?? "—",
      interface: n.interface ?? "—",
      platform: n.platform ?? "—",
      board: n["board"] ?? n["system-caps"] ?? "—",
    }));
  } catch {
    info.neighborCount = null;
    info.neighbors = [];
  }

  return info;
}

// قيمة الكرت → اسم البروفايل في اليوزر منجر
const VALUE_TO_PROFILE: Record<number, string> = {
  100: "100R.Y+4h",
  200: "200R.Y+10h",
  300: "300RY",
  500: "500RY",
};

// إنشاء مستخدم في اليوزر منجر وتعيين البروفايل عبر RouterOS API
// يستخدم add مع profile مدمج — timeout 90 ثانية لأن القاعدة كبيرة (43K+ مستخدم)
async function createMikrotikUser(
  username: string,
  profile?: string | null,
): Promise<{ created: boolean; profileSet: boolean; method: string }> {
  const client = getMikrotikClient();
  if (!client)
    return { created: false, profileSet: false, method: "no-config" };
  (client as any).on?.("error", () => {});

  let result: {
    created: boolean;
    profileSet: boolean;
    method: string;
    newUserId?: string;
  } = { created: false, profileSet: false, method: "none" };

  try {
    const conn = await withT(client.connect(), 12000);

    // محاولة إضافة المستخدم مع البروفايل في أمر واحد
    // نُجرّب "default-profile" لأن "profile" يُعطي "unknown parameter"
    const addParams: Record<string, string> = { username, customer: "admin" };
    if (profile) addParams["default-profile"] = profile;

    try {
      await withT(conn.menu("/tool/user-manager/user").add(addParams), 90000);
      result.created = true;
      result.profileSet = !!profile;
      result.method = profile ? "api-add-with-profile" : "api-add-only";
      console.info(`[UM] ✅ add(${JSON.stringify(addParams)}) → OK`);
    } catch (e: any) {
      const msg = (e?.message || "").toLowerCase();
      if (
        msg.includes("already") ||
        msg.includes("exists") ||
        msg.includes("duplicate")
      ) {
        result.created = true;
        console.info(
          `[UM] User already exists: ${username} — trying profile-only set`,
        );
        // المستخدم موجود، نحاول ربط البروفايل فقط
        if (profile) {
          try {
            // طريقة 1: set عبر where — نعثر على المستخدم ونُعدّل بروفايله
            await withT(
              conn
                .menu("/tool/user-manager/user")
                .where("username", username)
                .set({ profile }),
              90000,
            );
            result.profileSet = true;
            result.method = "api-set-profile";
            console.info(
              `[UM] ✅ set profile via where: ${profile} → ${username}`,
            );
          } catch (se: any) {
            console.warn(`[UM] set profile failed: ${se?.message}`);
            // طريقة 2: user-profile add
            try {
              await withT(
                conn
                  .menu("/tool/user-manager/user-profile")
                  .add({ user: username, profile }),
                90000,
              );
              result.profileSet = true;
              result.method = "api-user-profile-add";
              console.info(
                `[UM] ✅ user-profile add: ${profile} → ${username}`,
              );
            } catch (upe: any) {
              console.warn(`[UM] user-profile add failed: ${upe?.message}`);
            }
          }
        }
      } else {
        console.warn(`[UM] add failed: ${e?.message}`);
        // البروفايل غير مدعوم في add — أضف المستخدم أولاً بدون بروفايل
        try {
          const addRet = (await withT(
            conn
              .menu("/tool/user-manager/user")
              .add({ username, customer: "admin" }),
            90000,
          )) as any;
          result.created = true;
          // routeros-client v1.x يُعيد string ID أو {".id": "..."} أو {ret: "..."}
          const rawId =
            typeof addRet === "string"
              ? addRet
              : addRet?.[".id"] ||
                addRet?.ret ||
                addRet?.id ||
                JSON.stringify(addRet);
          result.newUserId = rawId;
          console.info(
            `[UM] ✅ add (no profile) → id=${rawId} user=${username}`,
          );
        } catch (ae: any) {
          const aeMsg = (ae?.message || "").toLowerCase();
          if (
            aeMsg.includes("already") ||
            aeMsg.includes("exists") ||
            aeMsg.includes("duplicate")
          ) {
            result.created = true;
            console.info(
              `[UM] User already exists (fallback path): ${username}`,
            );
          } else {
            console.warn(`[UM] add (no profile) failed: ${ae?.message}`);
          }
        }
      }
    }

    // ── بعد الإنشاء، نُحاول ربط البروفايل ──────────────────────────────────
    if (profile && result.created && !result.profileSet) {
      // طريقة A: set default-profile على المستخدم (أسرع من username scan)
      if (result.newUserId) {
        for (const fieldName of [
          "default-profile",
          "profile",
          "actual-profile",
        ]) {
          if (result.profileSet) break;
          try {
            await withT(
              conn
                .menu("/tool/user-manager/user")
                .where(".id", String(result.newUserId))
                .set({ [fieldName]: profile }),
              15000,
            );
            result.profileSet = true;
            result.method = `api-set-${fieldName}`;
            console.info(`[UM] ✅ set ${fieldName}: ${profile} → ${username}`);
          } catch (e: any) {
            console.warn(`[UM] set(${fieldName}) failed: ${e?.message}`);
          }
        }
      }

      // طريقة B: RouterOS Script — ننشئ script يُنفّذ أوامر CLI كاملة ثم نحذفه
      // هذا يُتيح وصولاً لأوامر user-profile التي لا تتوفر مباشرة في API
      if (!result.profileSet) {
        const scriptName = `um-pa-${Date.now()}`;
        const safeUser = username.replace(/"/g, "");
        const safeProfile = profile.replace(/"/g, "");
        // السكريبت يُشغَّل محلياً على الراوتر بصلاحيات كاملة
        // نستخدم :local للعثور على المستخدم ثم نُعيّن default-profile
        const scriptSource = `:local uid [/tool user-manager user find name="${safeUser}"]\n/tool user-manager user set \$uid default-profile="${safeProfile}"`;
        let scriptCreated = false;
        let createdScriptId: string | null = null;
        try {
          // أنشئ السكريبت واحصل على .id
          const addResult = (await withT(
            conn
              .menu("/system/script")
              .add({
                name: scriptName,
                source: scriptSource,
                "dont-require-permissions": "yes",
              }),
            15000,
          )) as any;
          scriptCreated = true;
          // routeros-client يُعيد الكائن بمفتاح "id" (بدون نقطة)
          createdScriptId =
            typeof addResult === "string"
              ? addResult
              : addResult?.id || addResult?.[".id"] || addResult?.ret || null;
          console.info(
            `[UM] Script created: ${scriptName} id=${createdScriptId}`,
          );

          // احصل على ID السكريبت من get() إذا لم نحصل عليه من add()
          if (!createdScriptId) {
            try {
              const fetchedScripts = (await withT(
                conn.menu("/system/script").where("name", scriptName).get(),
                10000,
              )) as any[];
              const fetched = fetchedScripts?.[0];
              createdScriptId = fetched?.id || fetched?.[".id"] || null;
              console.info(`[UM] Script id from get(): ${createdScriptId}`);
            } catch (ge: any) {
              console.warn(`[UM] Script get() failed: ${ge?.message}`);
            }
          }

          // شغّل السكريبت عبر rosApi.write مباشرة
          try {
            const rosApi = (conn as any).rosApi;
            if (
              rosApi &&
              typeof rosApi.write === "function" &&
              createdScriptId
            ) {
              await withT(
                rosApi.write(["/system/script/run", `=.id=${createdScriptId}`]),
                20000,
              );
              result.profileSet = true;
              result.method = "ros-script-raw";
              console.info(
                `[UM] ✅ profile set via script/run: ${profile} → ${username}`,
              );
            } else {
              console.warn(
                `[UM] Script run skipped: rosApi=${!!rosApi} id=${createdScriptId}`,
              );
            }
          } catch (runErr: any) {
            console.warn(`[UM] Script run failed: ${runErr?.message}`);
          }
        } catch (scriptErr: any) {
          console.warn(`[UM] Script create failed: ${scriptErr?.message}`);
        }

        // احذف السكريبت دائماً
        if (scriptCreated) {
          try {
            await withT(
              conn.menu("/system/script").where("name", scriptName).remove(),
              10000,
            );
            console.info(`[UM] Script deleted: ${scriptName}`);
          } catch (delErr: any) {
            console.warn(`[UM] Script delete failed: ${delErr?.message}`);
          }
        }
      }

      if (!result.profileSet) {
        console.warn(`[UM] ⚠️ Profile linking failed for ${username}`);
      }
    }

    try {
      await client.close();
    } catch {}
    return result;
  } catch (err: any) {
    try {
      await client.close();
    } catch {}
    console.warn("[UM] createMikrotikUser error:", err?.message);
    return result;
  }
}

// ─── Sync from MikroTik User Manager ───────────────────────────────────────
router.post("/admin/sync-mikrotik", async (req, res): Promise<void> => {
  if (!checkAdmin(req, res)) return;

  const client = getMikrotikClient();
  if (!client) {
    res.json({ error: "❌ إعدادات MikroTik غير موجودة" });
    return;
  }

  try {
    (client as any).on?.("error", () => {});
    const conn = await withT(client.connect(), 10000);

    const profiles = (await withT(
      conn.menu("/tool/user-manager/profile").get(),
      10000,
    )) as any[];
    const PROFILE_OVERRIDES: Record<string, number> = {
      "100R.Y+4h": 100,
      "200R.Y+10h": 200,
      "300RY": 300,
      "500RY": 500,
      Selefny: 100,
    };

    const profilePrice: Record<string, number> = {};
    for (const p of profiles) {
      if (PROFILE_OVERRIDES[p.name] !== undefined) {
        profilePrice[p.name] = PROFILE_OVERRIDES[p.name];
        continue;
      }
      const price = parseInt(p.price, 10);
      if (price > 0 && [50, 100, 200, 300, 500].includes(price)) {
        profilePrice[p.name] = price;
      }
    }
    console.info("[Sync] Profiles found:", profilePrice);

    console.info("[Sync] Fetching all users from User Manager...");
    const users = (await withT(
      conn.menu("/tool/user-manager/user").get(),
      110000,
    )) as any[];
    console.info("[Sync] Total UM users:", users.length);

    try {
      await client.close();
    } catch {}

    const existingRows = await pgDb
      .select({ cardNumber: vouchersTable.cardNumber })
      .from(vouchersTable);
    const existingCards = new Set(
      existingRows.map((r) => String(r.cardNumber)),
    );

    const existingRewards = await pgDb
      .select({ username: rewardCardsTable.username })
      .from(rewardCardsTable)
      .where(eq(rewardCardsTable.rewardType, "Selefny"));
    const existingRewardUsernames = new Set(
      existingRewards.map((r) => r.username),
    );

    let added = 0,
      skipped = 0,
      noProfile = 0,
      selefnyAdded = 0;
    const batch: {
      cardNumber: string;
      value: number;
      profile: string;
      source: string;
    }[] = [];
    const selefnyBatch: { username: string; rewardType: string }[] = [];

    for (const u of users) {
      const cardNumber = String(u.username || u.name || "").trim();
      if (!cardNumber) continue;

      if (
        u.disabled === true ||
        u.disabled === "true" ||
        u.disabled === "yes"
      ) {
        skipped++;
        continue;
      }

      const actualP = String(u.actualProfile || "").trim();
      const assignedP = String(
        u.profile || u["default-profile"] || u.group || "",
      ).trim();
      const profileName =
        actualP === "" || actualP.toLowerCase() === "unknown"
          ? assignedP
          : actualP;

      if (profileName === "Selefny") {
        if (!existingRewardUsernames.has(cardNumber)) {
          selefnyBatch.push({ username: cardNumber, rewardType: "Selefny" });
          existingRewardUsernames.add(cardNumber);
          selefnyAdded++;
          if (selefnyBatch.length >= 200) {
            const chunk = selefnyBatch.splice(0, 200);
            await pgDb
              .insert(rewardCardsTable)
              .values(chunk)
              .onConflictDoNothing();
          }
        } else {
          skipped++;
        }
        continue;
      }

      let value = profilePrice[profileName];
      if (!value) {
        const m = profileName.match(/^(\d+)/);
        if (m) {
          const n = parseInt(m[1], 10);
          if ([50, 100, 200, 300, 500].includes(n)) value = n;
        }
      }
      if (!value) {
        noProfile++;
        continue;
      }

      if (existingCards.has(cardNumber)) {
        skipped++;
        continue;
      }

      batch.push({
        cardNumber,
        value,
        profile: profileName,
        source: "mikrotik-um",
      });
      existingCards.add(cardNumber);
      added++;

      if (batch.length >= 500) {
        const chunk = batch.splice(0, 500);
        await pgDb.insert(vouchersTable).values(chunk).onConflictDoNothing();
      }
    }

    if (batch.length > 0) {
      await pgDb.insert(vouchersTable).values(batch).onConflictDoNothing();
    }
    if (selefnyBatch.length > 0) {
      await pgDb
        .insert(rewardCardsTable)
        .values(selefnyBatch)
        .onConflictDoNothing();
    }

    res.json({
      success: true,
      added,
      selefnyAdded,
      skipped,
      noProfile,
      total: users.length,
      profiles: profilePrice,
      message: `✅ تم استيراد ${added} كرت + ${selefnyAdded} كرت Selefny من أصل ${users.length} — تجاهل ${skipped} — ${noProfile} بدون باقة`,
    });
  } catch (err: any) {
    console.error("[Sync] Error:", err?.message);
    try {
      await client.close();
    } catch {}
    res.json({ error: `❌ خطأ في الاتصال: ${err?.message}` });
  }
});

// ─── Add single voucher + create in MikroTik ─────────────────────────────────
router.post("/admin/voucher", async (req, res): Promise<void> => {
  if (!checkAdmin(req, res)) return;
  const { cardNumber, value, profile } = req.body;
  if (!cardNumber || !value) {
    res.json({ error: "❌ أدخل رقم الكرت والقيمة" });
    return;
  }
  const numValue = parseInt(value, 10);
  if (![50, 100, 200, 300, 500].includes(numValue)) {
    res.json({ error: "❌ القيمة غير صحيحة" });
    return;
  }

  const assignedProfile = profile || VALUE_TO_PROFILE[numValue] || null;
  const cleanCard = cardNumber.trim();

  try {
    await pgDb.insert(vouchersTable).values({
      cardNumber: cleanCard,
      value: numValue,
      profile: assignedProfile,
      source: "manual",
    });
  } catch (e: any) {
    if (isDuplicateCard(e)) {
      res.json({ error: "❌ الكرت موجود مسبقاً في قاعدة البيانات" });
      return;
    }
    res.json({ error: `❌ خطأ: ${e?.message}` });
    return;
  }

  // الرد الفوري — اليوزر منجر يعمل في الخلفية (قد يستغرق حتى 90 ثانية)
  res.json({
    success: true,
    profile: assignedProfile,
    mikrotikCreated: false,
    profileAssigned: false,
    profileMethod: "pending",
    cardNumber: cleanCard,
    message: `✅ تم حفظ الكرت — جاري ربط البروفايل في اليوزر منجر (قد يستغرق دقيقة)`,
  });

  // ربط اليوزر منجر في الخلفية بعد الرد
  setImmediate(async () => {
    try {
      const r = await createMikrotikUser(cleanCard, assignedProfile);
      if (r.profileSet) {
        console.info(
          `[UM] ✅ Background: profile linked for ${cleanCard} via ${r.method}`,
        );
      } else if (r.created) {
        console.warn(
          `[UM] ⚠️ Background: user created but profile NOT linked for ${cleanCard}`,
        );
      } else {
        console.warn(`[UM] ❌ Background: failed for ${cleanCard}`);
      }
    } catch (e: any) {
      console.warn(
        `[UM] ❌ Background createMikrotikUser error: ${e?.message}`,
      );
    }
  });
});

// ─── Bulk add + create in MikroTik ───────────────────────────────────────────
router.post("/admin/vouchers/bulk", async (req, res): Promise<void> => {
  if (!checkAdmin(req, res)) return;
  const { value, cards, profile } = req.body;
  if (!cards || !value) {
    res.json({ error: "❌ أدخل الكروت والقيمة" });
    return;
  }
  const numValue = parseInt(value, 10);
  if (![50, 100, 200, 300, 500].includes(numValue)) {
    res.json({ error: "❌ القيمة غير صحيحة" });
    return;
  }

  const assignedProfile = profile || VALUE_TO_PROFILE[numValue] || null;
  const lines: string[] = cards
    .split(/[\n,،\s]+/)
    .map((c: string) => c.trim())
    .filter(Boolean);

  let added = 0,
    duplicates = 0,
    errors = 0,
    mikrotikAdded = 0;
  for (const cardNumber of lines) {
    try {
      await pgDb.insert(vouchersTable).values({
        cardNumber,
        value: numValue,
        profile: assignedProfile,
        source: "manual",
      });
      added++;

      // إضافة في اليوزر منجر مع تعيين البروفايل
      try {
        const r = await createMikrotikUser(cardNumber, assignedProfile);
        if (r.profileSet || r.created) mikrotikAdded++;
      } catch {}
    } catch (e: any) {
      if (isDuplicateCard(e)) duplicates++;
      else errors++;
    }
  }
  const skipped = duplicates + errors;
  res.json({
    success: true,
    added,
    skipped,
    duplicates,
    errors,
    mikrotikAdded,
    profile: assignedProfile,
    message: `✅ تم إضافة ${added} كرت (${mikrotikAdded} في اليوزر منجر)${duplicates > 0 ? ` — ${duplicates} مكرر` : ""}${errors > 0 ? ` — ${errors} خطأ` : ""}`,
  });
});

// ─── Loan cards (Selefny only) ────────────────────────────────────────────────
router.get("/admin/loan-cards", async (req, res): Promise<void> => {
  if (!checkAdmin(req, res)) return;

  const rows = await pgDb
    .select()
    .from(rewardCardsTable)
    .where(eq(rewardCardsTable.rewardType, "Selefny"))
    .orderBy(sql`${rewardCardsTable.createdAt} DESC`);

  const total = rows.length;
  const available = rows.filter((r) => !r.used).length;
  const used = total - available;
  const cards = rows.map((r) => ({
    id: String(r.id),
    cardNumber: r.username,
    value: 100,
    used: r.used,
    usedBy: r.usedBy || null,
    createdAt: r.createdAt?.toISOString() ?? "",
  }));

  res.json({ total, available, used, cards, profile: "Selefny" });
});

// ─── Add Selefny cards in bulk ────────────────────────────────────────────────
router.post("/admin/selefny/bulk", async (req, res): Promise<void> => {
  if (!checkAdmin(req, res)) return;
  const { cards } = req.body as { cards?: string };
  if (!cards) {
    res.json({ error: "❌ أدخل أرقام الكروت" });
    return;
  }

  const lines: string[] = cards
    .split(/[\n,،\s]+/)
    .map((c: string) => c.trim())
    .filter(Boolean);
  let added = 0,
    duplicates = 0,
    errors = 0;
  for (const username of lines) {
    try {
      await pgDb
        .insert(rewardCardsTable)
        .values({ username, rewardType: "Selefny" });
      added++;
    } catch (e: any) {
      if (isDuplicateCard(e)) duplicates++;
      else errors++;
    }
  }
  const skipped = duplicates + errors;
  res.json({
    success: true,
    added,
    skipped,
    duplicates,
    errors,
    message: `✅ تم إضافة ${added} كرت Selefny${duplicates > 0 ? ` — ${duplicates} مكرر` : ""}${errors > 0 ? ` — ${errors} خطأ` : ""}`,
  });
});

// ─── Delete Selefny card ──────────────────────────────────────────────────────
router.delete("/admin/selefny/:id", async (req, res): Promise<void> => {
  if (!checkAdmin(req, res)) return;
  const { id } = req.params;
  await pgDb
    .delete(rewardCardsTable)
    .where(eq(rewardCardsTable.id, parseInt(id, 10)));
  res.json({ success: true });
});

// ─── List vouchers ───────────────────────────────────────────────────────────
router.get("/admin/vouchers", async (req, res): Promise<void> => {
  if (!checkAdmin(req, res)) return;
  const rows = await pgDb
    .select()
    .from(vouchersTable)
    .orderBy(sql`${vouchersTable.createdAt} DESC`)
    .limit(300);
  const vouchers = rows.map((r) => ({
    id: String(r.id),
    cardNumber: r.cardNumber,
    value: r.value,
    profile: r.profile,
    used: r.used,
    usedBy: r.usedBy,
    createdAt: r.createdAt?.toISOString() ?? "",
  }));
  res.json({ vouchers });
});

// ─── Delete voucher ──────────────────────────────────────────────────────────
router.delete("/admin/voucher/:id", async (req, res): Promise<void> => {
  if (!checkAdmin(req, res)) return;
  const { id } = req.params;
  await pgDb
    .delete(vouchersTable)
    .where(eq(vouchersTable.id, parseInt(id, 10)));
  res.json({ success: true });
});

// ─── ربط كرت موجود ببروفايل في اليوزر منجر ────────────────────────────────────
router.post(
  "/admin/voucher/:id/link-profile",
  async (req, res): Promise<void> => {
    if (!checkAdmin(req, res)) return;
    const { id } = req.params;
    const { profile: overrideProfile } = req.body;

    const rows = await pgDb
      .select()
      .from(vouchersTable)
      .where(eq(vouchersTable.id, parseInt(id, 10)));
    const voucher = rows[0];
    if (!voucher) {
      res.json({ error: "❌ الكرت غير موجود" });
      return;
    }

    const targetProfile =
      overrideProfile ||
      voucher.profile ||
      VALUE_TO_PROFILE[voucher.value] ||
      null;
    if (!targetProfile) {
      res.json({ error: "❌ لا يوجد بروفايل لهذا الكرت" });
      return;
    }

    // تحديث البروفايل في DB إذا كان مختلفاً
    if (voucher.profile !== targetProfile) {
      await pgDb
        .update(vouchersTable)
        .set({ profile: targetProfile })
        .where(eq(vouchersTable.id, parseInt(id, 10)));
    }

    const umResult = await createMikrotikUser(
      voucher.cardNumber,
      targetProfile,
    );

    res.json({
      success: true,
      cardNumber: voucher.cardNumber,
      profile: targetProfile,
      created: umResult.created,
      profileSet: umResult.profileSet,
      method: umResult.method,
      message: umResult.profileSet
        ? `✅ تم ربط الكرت ${voucher.cardNumber} ببروفايل ${targetProfile} (${umResult.method})`
        : umResult.created
          ? `⚠️ تم إنشاء المستخدم لكن البروفايل لم يُعيَّن — جرب يدوياً في Winbox`
          : `❌ فشل الربط — تحقق من اتصال الروتر`,
    });
  },
);

// ─── MikroTik Profiles ───────────────────────────────────────────────────────
router.get("/admin/mikrotik-profiles", async (req, res): Promise<void> => {
  if (!checkAdmin(req, res)) return;

  const client = getMikrotikClient();
  if (!client) {
    res.json({ error: "❌ إعدادات MikroTik غير موجودة" });
    return;
  }

  try {
    (client as any).on?.("error", () => {});
    const conn = await withT(client.connect(), 10000);
    const profiles = (await withT(
      conn.menu("/tool/user-manager/profile").get(),
      10000,
    )) as any[];
    try {
      await client.close();
    } catch {}

    const PROFILE_OVERRIDES: Record<string, number> = {
      "100R.Y+4h": 100,
      "200R.Y+10h": 200,
      "300RY": 300,
      "500RY": 500,
      Selefny: 100,
    };

    const POINTS_MAP: Record<number, number> = {
      50: 1,
      100: 5,
      200: 10,
      300: 15,
      500: 20,
      1000: 40,
    };

    const result = profiles
      .map((p: any) => {
        let value = PROFILE_OVERRIDES[p.name];
        if (!value) {
          const price = parseInt(p.price, 10);
          if (price > 0) value = price;
        }
        const points = value
          ? (POINTS_MAP[value] ?? Math.floor(value / 20))
          : 0;
        return {
          name: p.name,
          price: parseInt(p.price, 10) || 0,
          value: value || 0,
          points,
          validity: p.validity || "",
        };
      })
      .filter((p: any) => p.name);

    res.json({ profiles: result });
  } catch (err: any) {
    try {
      await client.close();
    } catch {}
    res.json({ error: `❌ خطأ: ${err?.message}` });
  }
});

// ─── Selefny pool ─────────────────────────────────────────────────────────────
router.get("/admin/selefny-pool", async (req, res): Promise<void> => {
  if (!checkAdmin(req, res)) return;
  const rows = await pgDb
    .select({
      total: sql<number>`count(*)::int`,
      available: sql<number>`count(*) filter (where ${rewardCardsTable.used} = false)::int`,
      used: sql<number>`count(*) filter (where ${rewardCardsTable.used} = true)::int`,
    })
    .from(rewardCardsTable)
    .where(eq(rewardCardsTable.rewardType, "Selefny"));
  res.json(rows[0]);
});

// ─── Loan Config (Selefny only) ───────────────────────────────────────────────
router.get("/admin/loan-config", async (req, res): Promise<void> => {
  if (!checkAdmin(req, res)) return;
  res.json({ loanProfile: "Selefny" });
});

// ─── Stats ───────────────────────────────────────────────────────────────────
router.get("/admin/stats", async (req, res): Promise<void> => {
  if (!checkAdmin(req, res)) return;
  const [vRows, uRows] = await Promise.all([
    pgDb
      .select({
        total: sql<number>`count(*)::int`,
        used: sql<number>`count(*) filter (where ${vouchersTable.used} = true)::int`,
      })
      .from(vouchersTable),
    pgDb.select({ count: sql<number>`count(*)::int` }).from(usersTable),
  ]);
  const { total, used } = vRows[0];
  const usersCount = uRows[0].count;
  res.json({ total, used, available: total - used, usersCount });
});

// ─── Charge Requests (Admin) ──────────────────────────────────────────────────
router.get("/admin/charge-requests", async (req, res): Promise<void> => {
  if (!checkAdmin(req, res)) return;
  const rows = await pgDb
    .select()
    .from(chargeRequestsTable)
    .orderBy(desc(chargeRequestsTable.createdAt))
    .limit(100);
  res.json(
    rows.map((r) => ({
      id: String(r.id),
      userCode: r.userCode,
      service: r.service,
      amount: r.amount,
      phone: r.phone,
      txnRef: r.txnRef || "",
      status: r.status,
      assignedCard: r.assignedCard || null,
      adminNote: r.adminNote || null,
      createdAt: r.createdAt?.toISOString() ?? "",
    })),
  );
});

router.post(
  "/admin/charge-requests/:id/approve",
  async (req, res): Promise<void> => {
    if (!checkAdmin(req, res)) return;
    const { id } = req.params;
    const { cardNumber, adminNote, profile } = req.body as {
      cardNumber?: string;
      adminNote?: string;
      profile?: string;
    };

    if (!cardNumber) {
      res.status(400).json({ error: "❌ يجب إدخال رقم الكرت" });
      return;
    }

    const reqs = await pgDb
      .select()
      .from(chargeRequestsTable)
      .where(eq(chargeRequestsTable.id, parseInt(id, 10)))
      .limit(1);
    if (reqs.length === 0) {
      res.status(404).json({ error: "❌ الطلب غير موجود" });
      return;
    }
    const req_ = reqs[0];
    if (req_.status !== "pending") {
      res.status(400).json({ error: "❌ الطلب تمت معالجته مسبقاً" });
      return;
    }

    const finalCard = cardNumber.trim();
    const finalProfile = profile || VALUE_TO_PROFILE[req_.amount] || null;

    await pgDb
      .update(chargeRequestsTable)
      .set({
        status: "approved",
        assignedCard: finalCard,
        adminNote: adminNote || null,
      })
      .where(eq(chargeRequestsTable.id, parseInt(id, 10)));

    // ربط الكرت بالبروفايل في اليوزر منجر عبر SSH/API
    let umResult = { created: false, profileSet: false, method: "none" };
    if (finalProfile) {
      try {
        umResult = await createMikrotikUser(finalCard, finalProfile);
      } catch (e: any) {
        console.warn("[Approve] createMikrotikUser error:", e?.message);
      }
    }

    res.json({
      success: true,
      assignedCard: finalCard,
      profile: finalProfile,
      profileSet: umResult.profileSet,
      profileMethod: umResult.method,
      message: umResult.profileSet
        ? `✅ تم القبول وربط الكرت بالبروفايل ${finalProfile} (${umResult.method})`
        : finalProfile
          ? `✅ تم القبول — تعذّر ربط البروفايل تلقائياً، اربطه يدوياً في Winbox`
          : `✅ تم القبول`,
    });
  },
);

router.post(
  "/admin/charge-requests/:id/reject",
  async (req, res): Promise<void> => {
    if (!checkAdmin(req, res)) return;
    const { id } = req.params;
    const { adminNote } = req.body as { adminNote?: string };

    const reqs = await pgDb
      .select()
      .from(chargeRequestsTable)
      .where(and(eq(chargeRequestsTable.id, parseInt(id, 10))))
      .limit(1);
    if (reqs.length === 0) {
      res.status(404).json({ error: "❌ الطلب غير موجود" });
      return;
    }

    await pgDb
      .update(chargeRequestsTable)
      .set({ status: "rejected", adminNote: adminNote || null })
      .where(eq(chargeRequestsTable.id, parseInt(id, 10)));

    res.json({ success: true });
  },
);

// ─── Router Info (dashboard) ─────────────────────────────────────────────────
router.get("/admin/router-info", async (req, res): Promise<void> => {
  if (!checkAdmin(req, res)) return;

  const client = getMikrotikClient();
  const info: Record<string, any> = {};

  // DB stats
  try {
    const [vRows] = await pgDb
      .select({
        total: sql<number>`count(*)::int`,
        used: sql<number>`count(*) filter (where ${vouchersTable.used} = true)::int`,
      })
      .from(vouchersTable);
    info.dbCards = {
      total: vRows.total,
      used: vRows.used,
      available: vRows.total - vRows.used,
    };
  } catch (e: any) {
    info.dbCards = { error: e?.message };
  }

  if (!client) {
    res.json({ ...info, error: "❌ إعدادات MikroTik غير موجودة" });
    return;
  }

  try {
    (client as any).on?.("error", () => {});
    const conn = await withT(client.connect(), 10000);
    const routerData = await fetchRouterInfo(conn);
    try {
      await client.close();
    } catch {}
    res.json({ ...info, ...routerData });
  } catch (err: any) {
    try {
      await client.close();
    } catch {}
    res.json({ ...info, routerError: err?.message });
  }
});

// ─── معلومات السيرفر الثاني ─────────────────────────────────────────────────
router.get("/admin/router-info2", async (req, res): Promise<void> => {
  if (!checkAdmin(req, res)) return;

  const client = getMikrotikClient2();
  if (!client) {
    res.json({ error: "❌ إعدادات السيرفر الثاني غير موجودة (MIKROTIK_URL2)" });
    return;
  }

  try {
    (client as any).on?.("error", () => {});
    const conn = await withT(client.connect(), 10000);
    const routerData = await fetchRouterInfo(conn);
    try {
      await client.close();
    } catch {}
    res.json(routerData);
  } catch (err: any) {
    try {
      await client.close();
    } catch {}
    res.json({ routerError: err?.message });
  }
});

// ─── MikroTik Diagnostic ─────────────────────────────────────────────────────
router.get("/admin/mikrotik-diag", async (req, res): Promise<void> => {
  if (!checkAdmin(req, res)) return;
  const client = getMikrotikClient();
  if (!client) {
    res.json({ error: "❌ إعدادات MikroTik غير موجودة" });
    return;
  }

  const results: Record<string, any> = {};

  try {
    (client as any).on?.("error", () => {});
    const conn = await withT(client.connect(), 10000);
    const rosApi = (conn as any).rosApi;

    // 1) إصدار RouterOS
    try {
      const ver = (await withT(
        conn.menu("/system/resource").get(),
        5000,
      )) as any[];
      results.version =
        ver?.[0]?.["ros-version"] || ver?.[0]?.version || "unknown";
    } catch (e: any) {
      results.version = `error: ${e?.message}`;
    }

    // 2) قراءة user-profile (print)
    const printPaths = [
      "/tool/user-manager/user-profile",
      "/tool/user-manager/user-profiles",
      "/tool/user-manager/batch",
      "/tool/user-manager/user-batch",
      "/tool/user-manager/userprofile",
    ];
    results.printTests = {};
    for (const p of printPaths) {
      try {
        const r = (await withT(conn.menu(p).get(), 3000)) as any[];
        results.printTests[p] = `OK — ${r.length} records`;
      } catch (e: any) {
        results.printTests[p] = `FAIL: ${e?.message}`;
      }
    }

    // 3) تجربة add على user-profile بمستخدم وهمي TEST
    const addPaths: string[][] = [
      [
        "/tool/user-manager/user-profile/add",
        "=user=TEST_DIAG",
        "=profile=TEST",
      ],
      ["/tool/user-manager/batch/add", "=user=TEST_DIAG", "=profile=TEST"],
      ["/tool/user-manager/user-batch/add", "=user=TEST_DIAG", "=profile=TEST"],
    ];
    results.addTests = {};
    for (const cmd of addPaths) {
      try {
        await withT(rosApi.write(cmd), 3000);
        results.addTests[cmd[0]] = "OK (unexpected!)";
      } catch (e: any) {
        results.addTests[cmd[0]] = `${e?.message}`;
      }
    }

    try {
      await client.close();
    } catch {}
    res.json({ success: true, results });
  } catch (err: any) {
    try {
      await client.close();
    } catch {}
    res.json({ error: err?.message, results });
  }
});

// --- تشخيص HTTP واجهة اليوزر منجر ---
router.get("/http-diag", async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const rawUrl = process.env.MIKROTIK_URL || "";
  const routerHost = new URL(rawUrl).hostname;
  const user = process.env.MIKROTIK_USER || "admin";
  const pass = process.env.MIKROTIK_PASS || "";
  const creds = Buffer.from(`${user}:${pass}`).toString("base64");
  const basic = `Basic ${creds}`;
  const out: Record<string, any> = {};

  // 1) GET homepage
  for (const port of [81, 80]) {
    const url = `http://${routerHost}:${port}/userman/`;
    try {
      const r = await withT(
        fetch(url, { headers: { Authorization: basic } }),
        5000,
      );
      const body = await r.text();
      out[`GET:${url}`] = { status: r.status, body: body.slice(0, 500) };
    } catch (e: any) {
      out[`GET:${url}`] = { error: e?.message };
    }
  }

  // 2) POST userProfile/create على port 81
  const postUrl = `http://${routerHost}:81/userman/userProfile/create`;
  const testUser = "HTTPDTEST1";
  const testProfile = "200R.Y+10h";
  const forms = [
    `user=${encodeURIComponent(testUser)}&profile=${encodeURIComponent(testProfile)}&customer=admin`,
    `username=${encodeURIComponent(testUser)}&profile=${encodeURIComponent(testProfile)}&customer=admin`,
    `user=${encodeURIComponent(testUser)}&profile=${encodeURIComponent(testProfile)}`,
  ];
  for (const body of forms) {
    try {
      const r = await withT(
        fetch(postUrl, {
          method: "POST",
          headers: {
            Authorization: basic,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        }),
        5000,
      );
      const txt = await r.text();
      out[`POST:${body.slice(0, 40)}`] = {
        status: r.status,
        body: txt.slice(0, 600),
      };
    } catch (e: any) {
      out[`POST:${body.slice(0, 40)}`] = { error: e?.message };
    }
  }

  res.json(out);
});

export default router;
