# Offline Facade Boundaries (Gate 3)

```yaml
track: C-facade-boundaries
updated: 2026-07-22T17:10:40+0800
status: partial
frida: forbidden
emulator: forbidden
network: forbidden
apk_mutation: forbidden
evidence_sources:
  - jadx-core/sources (outer SDK DEX)
  - runtime/dex/core-classes.dex → jadx-facade-slice/{SdkController,MessiahNativeActivity}.java
  - runtime/logs/g1-local-evidence/{shape-script-hits.json,script_*.luac,script-pet-strings.txt}
  - docs/IMPLEMENTATION_SPEC.md Offline Game Facade
```

## Verdict

Gate 3 requires **at least one replaceable UI→business boundary without forging remote responses**.

**Clearest verified in-process cut points (Java):**

1. `com.netease.my.SdkController.openLoginView()` → `SdkMgr.ntLogin()` — replace with local profile / local Intent.
2. `com.netease.my.SdkController.buyProduct*` → `SdkMgr.ntCheckOrder(OrderInfo)` — disable real pay; grant via local economy (not fake MPay success).
3. `com.netease.game.MessiahNativeActivity.showPatcher*` / `onClickPatchRepair` → patch UI; pair with local fail-open of patch list, **not** CDN forgery.

Gameplay (抽奖/合宠/个人战斗/游戏内商城) authority sits mainly in **Lua script + Messiah/native protocol** (`C_*` / `S_*` symbols). Those are **partial** string-level candidates until a send/dispatch hook is mapped; do not claim full offline playability from UI names alone.

---

## Layer model

```text
Android UI / Splash / Patch dialogs
        │
        ▼
Java SdkController / UniSDK / MPay / PatchList*     ← in-process replaceable (verified)
        │
        ▼
MessiahNativeActivity + libGame.so (engine/render)  ← keep for rendering; do not fake CDN
        │
        ▼
Lua @view/* / war.* / JsonConfig                    ← UI + client rules (partial symbols)
        │
        ▼
C_*/S_* gameplay opcodes → game server protocol    ← must stub/local-authority OR bypass
        │
        ▼
Offline Game Facade → Local Store (future)
```

---

## 1. Login / 补丁

| Symbol | Layer | Replaceability | Role |
|---|---|---|---|
| `com.netease.my.SdkController.openLoginView` | Java | **in-process** | Calls `SdkMgr.getInst().ntLogin()` |
| `SdkController.checkLoginSucc(uid, access_token)` | Java | **in-process** | Sets `UID`/`SESSION` props |
| `SdkController.gameLoginSuccess` | Java | **in-process** | `ntGameLoginSuccess()` |
| `SdkController.isLogined` | Java | **in-process** | `hasLogin()` |
| `SdkController.relogin` / `logout` | Java | **in-process** | Channel re-auth |
| `com.netease.ntunisdk.base.GamerInterface.ntLogin` | Java | **in-process** | UniSDK login API |
| `com.netease.loginapi.INELoginAPI` / `MpayApi` | Java | **in-process** | Outer auth/pay SDK (disable) |
| `MessiahNativeActivity.showPatcherAlert/Hint/Repair` | Java | **in-process** | Offline patch failure UI |
| `MessiahNativeActivity.onClickPatchRepair` | Java | **in-process** | `Platform.OnPatcherRepair()` |
| `PatchListProxy` / `PatchListCore` | Java | **in-process** | HTTP fetch of patch list via OkHttp |
| Dynamic URL / shapeconfig THX missing 3 | native | **must native / local assets** | Do **not** forge third-party CDN success |

### Suggested offline facade cut

- **Primary:** wrap/replace `SdkController.openLoginView` + login-done callback path → synthesize local `UID`/`SESSION` and call into game as “already logged in” **or** skip to local profile Intent.
- **Patch:** make `PatchListProxy.needDownload()` always false when local package deemed complete; or native fail-open past patch gate using only base HashRes. **Forbidden:** fake HTTP 200 with invented remote payloads for third-party hosts.
- Evidence strength: **verified** (decompiled methods).

---

## 2. 商城购买 (real IAP vs in-game shop)

### 2a Real payment (仙玉 / channel pay) — Java

| Symbol | Notes |
|---|---|
| `SdkController.buyProduct(...)` | Builds `OrderInfo`, sets currency `仙玉`, calls `ntCheckOrder` |
| `SdkController.buyProductGas3(...)` | Gas3 order path → `ntCheckOrder` |
| `SdkController.orderCheckDone(OrderInfo)` | **native** callback into game |
| `GamerInterface.ntCheckOrder` / `ntPrePay` / `ntVerifyOrder` | UniSDK order pipeline |
| `PayManager` / `PaymentCallback` / `OrderCallback.onOrderPurchased` | Channel pay plumbing |

**Replaceability:** Java/in-process for *disabling* real pay. Inventory grant must go through local facade transaction, then refresh UI — **not** a forged payment success toast alone.

### 2b In-game beast/mall UI — Lua (partial)

| Symbol | Notes |
|---|---|
| `@view/beast_shop.lua` | Beast shop view |
| `gotoMallBuyBeast` / `gotoMallBuy*` | Navigation to mall buy |
| `BuyBeast` / `BeastinfoBuy` | Buy actions |
| `CMall` / `.mall.CShop` | Mall controller-ish |
| `C_REQ_BUY` / `C_REQ_BUY_LUCKY_CARD_GOODS` / `C_NEWSVR_SUPER_SUM_BUY` / `C_REQ_SPECMALL` | Client→server buy opcodes (string hits) |
| `1/mall/perkIcon/%d.png` | Mall UI asset path |

**Replaceability:** UI scripts are process-local, but authoritative stock change is likely `C_*` → server. Offline path: intercept before opcode send **or** replace shop controller methods to call Offline Facade `purchase` transaction, then feed isomorphic bag/pet DTO into existing UI refresh.

---

## 3. 抽奖 / 召唤

| Symbol | Layer | Evidence |
|---|---|---|
| `ImgBeastLottery` | Lua/UI widget | strings in `script_infoshapemap_*` / script-pet |
| `CLotteryBigAward` | Lua controller | beast script |
| `CSuperSummonGiftBox` | Lua | beast / new-server summon gift |
| `getMySummon` / `checksummon` / `SUPERSUMMON` | Lua | script-pet-strings |
| `C_NEWSVR_SUPER_SUM_BUY` / `C_REQ_BUY_LUCKY_CARD_GOODS` | protocol-ish | buy/summon related |
| `SkillPool` | config name | may be skill pool, not gacha — weak |

**Suggested cut:** UI click on `ImgBeastLottery` / summon gift → Offline Facade `gacha.draw(request_id)` → commit journal → **then** invoke original result UI with isomorphic reward DTO. Do not show win UI before commit.

**Replaceability:** UI local; RNG/pity/inventory **must** be facade-local. Opcode path is **native/script-protocol** until send boundary named.

---

## 4. 合宠 (Merge / child beast)

English `fuse/fusion` nearly absent. Strongest candidates:

| Symbol | Layer | Notes |
|---|---|---|
| `@JsonConfig/newbiepark/beast/NewServerMergePetsCulture.lua` | JsonConfig script | Merge pets culture rules |
| `NewServerMergePets` | Lua symbol | Merge feature namespace |
| `cur_child_beast` | Lua state | Child/result beast |
| `@view/child_skill.lua` | view | Child skill UI |
| `@view/beastinfo.lua` / `@view/beast_handbook.lua` | view | Result display reuse |

**Suggested cut:** Merge confirm handler → Offline Facade `fusion.apply(parent_a, parent_b, formula_ver, seed)` → write `pet_instance` + journal → push `cur_child_beast`-shaped DTO into existing result/detail views.

**Replaceability:** formula/transaction local; presentation reuses beast info views. Protocol confirm (if any) must be bypassed — **partial**.

---

## 5. 个人战斗

| Symbol | Layer | Notes |
|---|---|---|
| `BeastFight` / `FightBeast` / `GetFightBeast` / `updateFightBeast` | Lua | Fight beast roster |
| `war.fightskill` / `@war/fightrecord.lua` | Lua war module | Skills / records |
| `NostalgiaBeastBattle.json5` | Json config | Named PVE-ish battle config |
| `IsCombatModelOpen` / `FightBout` / `FightWinUI` | Lua | Combat mode / bout / win UI |
| `ControlFightCommandSommon` / `FightCommandSommonTip` | Lua | Fight commands / summon |
| `BattleBeastSelectionItem` / `FIGHT_PREPARE_BEAST` | Lua UI | Prep selection |
| `res_fight_misc` / formation packs | resources | VFX/misc (resource audit) |

**Suggested cut:** enter fixed-enemy battle via local Intent/config (`NostalgiaBeastBattle` candidate) → Offline Facade owns state machine (`Created→…→RewardCommitted`) → drive existing `FightWinUI` only after reward commit.

**Replaceability:** prep/win UI local; turn authority / damage / rewards likely native or `C_*` — treat as **must stub or reimplement locally** (partial). Rendering stays on Messiah.

---

## Replaceability matrix

| Domain | In-process replaceable (Java/Lua UI) | Must native / protocol stub | Forge remote? |
|---|---|---|---|
| Login SDK | `SdkController.openLoginView` / login callbacks | Game-server role enter if separate from UniSDK | No |
| Real pay | `buyProduct*` → skip `ntCheckOrder` | `orderCheckDone` native if game waits on it — supply local OrderInfo locally | No (no fake MPay) |
| Patch gate | `showPatcher*`, `PatchListProxy.needDownload` | libGame missing-object gate / THX completeness | No CDN forgery |
| In-game mall | `@view/beast_shop.lua`, `BuyBeast` | `C_REQ_*BUY*` send | No |
| Gacha | `ImgBeastLottery`, summon gift UI | result opcode / bag sync | No |
| Fusion | `NewServerMergePets*`, `cur_child_beast` | merge confirm opcode if present | No |
| Battle | fight UI / `NostalgiaBeastBattle.json5` | fight state machine / reward opcode | No |
| Pet render | — | Messiah/`libGame` resource pipeline | No |

---

## Top offline facade entry points (priority)

1. **`SdkController.openLoginView` + `gameLoginSuccess` / `checkLoginSucc`** — local account; bypass UniSDK/MPay login. *(verified, Gate-3 qualifying)*
2. **`SdkController.buyProduct` / `buyProductGas3` + native `orderCheckDone`** — kill real pay; local wallet/inventory grant. *(verified surface)*
3. **`PatchListProxy.needDownload` / `MessiahNativeActivity.showPatcherRepair`** — offline package fail-open; no third-party list fetch. *(verified surface)*
4. **`@view/beast_shop.lua` + `BuyBeast` / `gotoMallBuyBeast`** — free in-game shop facade before `C_REQ_*BUY*`. *(partial)*
5. **`ImgBeastLottery` + `CSuperSummonGiftBox` / summon helpers** — gacha facade → then result UI. *(partial)*
6. **`NewServerMergePets` + `cur_child_beast` + `NewServerMergePetsCulture.lua`** — fusion facade. *(partial)*
7. **`BeastFight` / `updateFightBeast` + `NostalgiaBeastBattle.json5` + `FightWinUI`** — fixed-enemy battle facade. *(partial)*

---

## Thinking: DTO isomorphism / local Intent / Messiah bypass

### DTO isomorphism

Old client expects concrete shapes (OrderInfo fields; Lua tables for beast/bag/fight). Facade should emit **same field names/types** the UI already reads:

- Login: `UID`, `SESSION`, `USERINFO_*` props (`SdkController.checkUserInfo` already writes these).
- Pay: `OrderInfo` with status consumed/`orderCheckDone` without channel SDK.
- Pets: snapshot matching whatever `beastinfo` / `cur_child_beast` consume (species, skills, appearance ids) — exact schema still **unknown** until one decrypted Json/script struct is pinned.
- Gacha/fight: reward lists isomorphic to existing win/lottery panels.

No need to speak HTTP to third parties if UI only consumes in-memory DTOs + local store.

### Local Intent instead of network

- Cold start: Activity Intent extras → `setUserStartInfo` / local profile id (skip announcement/login web).
- Feature entry: explicit Intent/deep-link style hooks into local “scene ids” (e.g. open beast shop / fixed battle) once patch/login gates are open — still must not pretend server ack.
- IPC only loopback/local files if anything; prefer in-process facade calls from Java/Lua bridges.

### What can fully bypass Messiah protocol layer

| Can bypass Messiah game protocol | Cannot / should not bypass |
|---|---|
| UniSDK login + MPay/real pay | Messiah rendering / animation / resource decode |
| Patch list HTTP download (local-complete + fail-open) | libGame asset resolution for models/textures |
| Analytics / Pharos / upload_* in SdkController | GL/shader/scene pipeline |
| Optional: entire online world sync if single-player shell drives UI from Local Store | Any claim of “online-consistent” economy |

Practical offline architecture: **keep Messiah as renderer + Lua UI shell; replace authority at SdkController + Lua net-send / opcode dispatch with Offline Facade + SQLite.** Do not stand up a fake public game server.

---

## Evidence strength & anti-patterns

| Claim | Strength |
|---|---|
| SdkController / MessiahNativeActivity / PatchList* method surfaces | **verified** (core DEX jadx) |
| Named Lua views/controllers/opcodes exist in decrypted script blobs | **partial** (string presence; call graph not proven this track) |
| Exact gacha pity table / fusion formula / fight damage authority location | **unknown** |
| Forging CDN/MPay success as offline strategy | **rejected** |

Anti-patterns for later agents:

- Do not use Frida/emulator on this track’s deliverable path.
- Do not treat UI widget existence as “gacha offline done”.
- Do not HTTP-fake shapeconfig/CDN.
- Do not show lottery/fight/shop success before Local Store commit.

## Commands / env (repro)

```bash
export MXXY_WORK=/Users/ezer/Documents/ZendeskToFeishu/private-mxxy-work
jadx --single-class com.netease.my.SdkController \
  --single-class-output $MXXY_WORK/runtime/logs/jadx-facade-slice/SdkController.java \
  $MXXY_WORK/runtime/dex/core-classes.dex
# Script symbols: g1-local-evidence/shape-script-hits.json + script_*.luac strings
```

## Next (static-only)

1. Pin Lua net-send / opcode dispatch symbol (string xref across full `script` WPK decrypt set).
2. Decrypt/locate `NewServerMergePetsCulture.lua` and `NostalgiaBeastBattle.json5` plaintext structs for DTO fields.
3. Draft Offline Facade API matching IMPLEMENTATION_SPEC transactions (still no fake UI).
