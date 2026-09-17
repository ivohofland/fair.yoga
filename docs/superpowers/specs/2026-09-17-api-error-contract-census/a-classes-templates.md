# Census A: class, template and studio mutating routes (#197 premise check)

> **Record, not reference.** A subagent census taken for the #197 spec
> (`../2026-09-17-api-error-contract-design.md`) by reading the tree at
> `4e1ec6e4`. Line numbers are as of that commit. No tests were run.

Paths are repo-relative.

## Legend

All paths are relative to the worktree.

| abbr | path |
|---|---|
| CT | `src/app/api/class-templates/route.ts` |
| CTi | `src/app/api/class-templates/[id]/route.ts` |
| C | `src/app/api/classes/route.ts` |
| Ci | `src/app/api/classes/[id]/route.ts` |
| Ccan | `src/app/api/classes/[id]/cancel/route.ts` |
| Ccom | `src/app/api/classes/[id]/complete/route.ts` |
| Ctr | `src/app/api/classes/[id]/transition/route.ts` |
| ST | `src/app/api/studio-class-templates/route.ts` |
| STi | `src/app/api/studio-class-templates/[id]/route.ts` |
| SC | `src/app/api/studio-classes/route.ts` |
| SCi | `src/app/api/studio-classes/[id]/route.ts` |
| RL | `src/services/rule-lifecycle.ts` |
| CTL | `src/services/class-template-lifecycle.ts` |
| STL | `src/services/studio-class-template-lifecycle.ts` |
| CL | `src/services/class-lifecycle.ts` |
| EC | `src/lib/entry-conflict.ts` |
| RSH | `src/lib/rule-slot-holder.ts` |
| SCER | `src/services/studio-class-edit-refusals.ts` |
| SCD | `src/services/studio-class-deletion.ts` |
| tCT | `tests/integration/class-templates-api.test.ts` |
| tC | `tests/integration/classes-api.test.ts` |
| tS | `tests/integration/studio-api.test.ts` |
| tX | `tests/integration/cross-family-slot-api.test.ts` |
| uCT | `src/app/api/class-templates/[id]/unknown-slot-holder.test.ts` (route handler, service mocked) |
| uVR | `src/app/api/class-templates/[id]/vanished-room-double-race.test.ts` (route handler, service mocked) |
| uST | `src/app/api/studio-class-templates/[id]/unknown-slot-holder.test.ts` (route handler, service mocked) |
| uC | `src/app/api/classes/route.test.ts` (route handler, real DB) |

The **tests** column covers HTTP-level assertions only: `tests/integration/*` plus the route-handler tests under `src/app/api/**`. Tests that only check a service's return value are marked "service-level only". Assertion kinds: **S** = status, **C** = code, **M** = message prose (exact, contains or regex, as noted). E2e and component tests were not searched.

Shared message sources:
- **SLOT_TAKEN (class family)**: `regular` → `You already have a recurring class at an overlapping time on that day.`; `studio` → `You already have a recurring studio class at an overlapping time on that day.`; `unknown` → `You already have a recurring class or studio class at an overlapping time on that day.` The same three sentences appear in the studio maps (ST:27-40, STi:33-46) with different codes. `heldBy` comes from RSH:109-143, which returns `unknown` if the probe throws or no live rule is found.
- **entryConflictMessage** (EC:337-346): `You already have a ${FAMILY_NOUN[conflict.kind]} at ${HH:MM} on ${formatDateWithYear(date)}.`, or when the probe finds nothing (or fails) `You already have a ${FAMILY_NOUN[caller]} that overlaps that time.` FAMILY_NOUN is `class` / `studio class` (EC:52-55).

Out-of-scope baseline per pair: `requireTeacher` produces 3 responses (401 `Authentication required`, 401 `Session expired`, 403 `Teacher access required`; `src/lib/api-utils.ts:47,49,59`), and `parseBody` produces 2 (400 `Invalid JSON`, 400 schema text; `api-utils.ts:81,89`).

---

## 1. POST /api/class-templates

**A. Client callers**
- `src/components/settings/template-form.tsx:305`. The URL is chosen at :287 (create mode). The error is read with `readErrorMessage` (:317) and shown as red `role="alert"` text (:677).

**B.**

| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 400 | `Invalid teacher room` | — | CT:75 | CT:75 | GENUINE | DEV | none |
| 409 | `This room is archived. Unarchive it to add a recurring class here.` | ROOM_ARCHIVED | CT:89 (pre-check), CT:117 (constraint catch) | CT:88, CT:116 | GENUINE | USER | tCT:457-459 S+C |
| 409 | SLOT_TAKEN.regular | DUPLICATE_TEMPLATE_SLOT | CT:36-37 (heldBy: CTL:1067-1074) | CT:131 | **BOTH**: a replay after commit collides with its own new rule (probe says `regular`); also another template in the slot | USER | tCT:358-359 S+C (the sequential replay); tCT:406 C (concurrent) |
| 409 | SLOT_TAKEN.studio | CROSS_FAMILY_STUDIO_TEMPLATE_SLOT | CT:40-41 | CT:131 | GENUINE | USER | tCT:512-517 S+C+M(regex /overlapping/); tCT:555-557 S+C; tX:256-258 S+C+M(regex) |
| 409 | SLOT_TAKEN.unknown | TEMPLATE_SLOT_CONFLICT | CT:44-45 | CT:131 | **BOTH**: after commit only if the probe throws (RSH:130-141; create passes no `excludeRuleId`); otherwise the holder was archived in the gap | USER | none |
| 503 | `The system was busy and could not create this recurring class. Nothing was created. Wait a moment, then try again.` | TEMPLATE_BUSY | CT:135 (service: CTL:1057-1062) | CT:134 | GENUINE (transient) | USER | none |

**C. Replaying the same request after it committed:** the second call gets 409 DUPLICATE_TEMPLATE_SLOT. `createManyAndReturn({skipDuplicates})` returns no row because the first call's live rule overlaps (CTL:998-1012), the probe then answers `regular` (CTL:1067-1074), and the route maps it at CT:125-131. Pinned by tCT:351-359.

**Out of scope:** 5 (3 auth + 2 parseBody).

---

## 2. PUT /api/class-templates/[id]

**A. Client callers**
- `src/components/settings/template-form.tsx:305`. URL :288 and method PUT :289 in edit mode. Error read with `readErrorMessage` (:317), shown as red `role="alert"` text (:677).

**B.**

| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Class template not found` | — | CTi:314 (reason from RL:1644, RL:1742) | CTi:314 | GENUINE | DEV? (the model name "template"; UI copy says "recurring class") | tCT:1381-1393 S |
| 403 | `Access denied` | — | CTi:315 (RL:1645, ownership) | CTi:315 | GENUINE | DEV? (generic auth wording, no remedy) | tCT:1410-1418 S; tCT:2491-2493 S + C≠ROOM_ARCHIVED |
| 400 | `Invalid teacher room` | — | CTi:193 (pre-check: target missing or not owned), CTi:262 (room vanished after constraint), CTi:317 (RL:1665, 1669, 1789) | same lines | GENUINE | DEV | tCT:1444-1452 S; uVR:96-98 S+M(exact) for the :262 arm; uVR:168 S for :193 |
| 409 | `This room is archived. Unarchive it to move this recurring class here.` | ROOM_ARCHIVED | CTi:70 (`roomArchivedResponse`) | CTi:196 (pre-check), CTi:274 (catch) | GENUINE (the pre-check only fires when the room changes, CTi:180) | USER | tCT:2232-2237 S+C+M(exact); uVR:199-201 S+C |
| 409 | SLOT_TAKEN.regular | DUPLICATE_TEMPLATE_SLOT | CTi:48-49 (RL:1745-1762) | CTi:321-322 | GENUINE (`excludeRuleId`, RL:1756) | USER | tCT:2112-2114 S+C |
| 409 | SLOT_TAKEN.studio | CROSS_FAMILY_STUDIO_TEMPLATE_SLOT | CTi:52-53 | CTi:321-322 | GENUINE | USER | tCT:2672-2675 S+C+M(regex); tX:269-271 S+C+M(regex) |
| 409 | SLOT_TAKEN.unknown | TEMPLATE_SLOT_CONFLICT | CTi:56-57 | CTi:321-322 | GENUINE | USER | uCT:60-65 S+C+M(exact) |
| 503 | `The system was busy and could not save your changes to this recurring class. Nothing was changed. Wait a moment, then try again.` | TEMPLATE_BUSY | CTi:111 (`templateEditBusyResponse`); reason from RL:1734 | CTi:285 (room un-archived race), CTi:332 | GENUINE (transient) | USER | tCT:1205-1221 S+C+M(contains); uVR:231-233 S+C |

**C. Replay:** 200 with the same body. The write sets the same values, the exclusion constraint excludes the rule's own row, and the room pre-check is skipped because the room is unchanged (CTi:177-181). `updateChild` only writes `roomArchived` when the room changes (CTL:882-886). Path: RL:1674-1826.

**Out of scope:** 6 (3 auth + 2 parseBody + 400 `No valid fields to update` at CTi:316, from RL:1653).

---

## 3. PATCH /api/class-templates/[id] (`?state=`)

**A. Client callers**
- `src/components/settings/toggle-template-button.tsx:33` (paused/active). `readErrorMessage` :69, red `role="alert"` text :88.
- `src/components/settings/archive-template-button.tsx:31` (archived/unarchived). `readErrorMessage` :67, red `role="alert"` text :86.

**B.**

| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Class template not found` | — | CTi:391 (RL:405, 521, 626), CTi:515 (RL:1103, 1474) | CTi:391, CTi:515 | GENUINE | DEV? (model name "template") | none |
| 403 | `Access denied` | — | CTi:392 (RL:406), CTi:516 (RL:1104) | same | GENUINE | DEV? | tCT:2443-2445 S + C≠ROOM_ARCHIVED |
| 409 | SLOT_TAKEN.regular (unarchive only) | DUPLICATE_TEMPLATE_SLOT | CTi:48-49 (RL:884-896) | CTi:398-399 | GENUINE (a replay takes the `unchanged` fast path) | USER | tCT:1023-1025 S+C |
| 409 | SLOT_TAKEN.studio (unarchive only) | CROSS_FAMILY_STUDIO_TEMPLATE_SLOT | CTi:52-53 | CTi:398-399 | GENUINE | USER | tX:284-286 S+C+M(regex) |
| 409 | SLOT_TAKEN.unknown (unarchive only) | TEMPLATE_SLOT_CONFLICT | CTi:56-57 | CTi:398-399 | GENUINE | USER | none |
| 503 | `` `The system was busy and could not ${state === 'archived' ? 'archive' : 'unarchive'} this recurring class. Nothing was changed. Wait a moment, then try again.` `` | TEMPLATE_BUSY | CTi:403 (RL:867 transient; RL:672 when the CAS re-read finds a third request reversed the change) | CTi:402 | GENUINE (transient or reversed) | USER | tCT:1104-1108 S+C+M(contains), archive |
| 409 | `This room is archived. Unarchive it to resume this recurring class.` | ROOM_ARCHIVED | CTi:69 | CTi:454 (pre-check), CTi:466 (CHECK catch) | GENUINE | USER | tCT:2384-2389 S+C+M(exact) |
| 409 | `Unarchive the template before activating it` | — | CTi:521 (RL:1129, 1476) | CTi:521 | GENUINE | DEV? (says "template"; the imperative does give a remedy) | tCT:667 S; tCT:2549-2552 S+M(exact) + C≠ROOM_ARCHIVED |
| 503 | `The system was busy and could not update this recurring class. Nothing was changed. Wait a moment, then try again.` | TEMPLATE_BUSY | CTi:525 (RL:1438, 1478) | CTi:524 | GENUINE (transient) | USER | tCT:1153-1162 S+C+M(contains) |

**Relies on a generic fallback:** `?state=active` deliberately rethrows `CalendarEntry_teacher_slot_excl` raised during resume generation (RL:1441-1450). `classifyApiError` turns it into 409 `You already have a class or studio class at an overlapping time on that date.` with no code (`src/lib/api-errors.ts:567-573`). Not counted as a row.

**C. Replay:** 200 with `action: 'unchanged'`. Fast paths: RL:426-432 (archive/unarchive) and RL:1115-1121 (pause/resume). Pinned by the idempotency tests at tCT:858-990.

**Out of scope:** 4 (3 auth + 400 `A state of active, paused, archived or unarchived is required` at CTi:354).

---

## 4. POST /api/classes

**A. Client callers**
- `src/app/(teacher)/class/new/page.tsx:296`. Custom parse (`json.error?.message`, :303-304). Red `role="alert"` text :664-665.

**B.**

| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 400 | `Invalid teacher room` | — | C:81 (pre-check), C:192 (room deleted in-transaction; reason born C:126) | C:81, C:192 | GENUINE | DEV | tC:1382-1384 S; tC:1392-1394 S; tC:1467-1471 S+M(exact) (C:192 arm); uC:126-130 S+M(exact) (C:192 arm) |
| 409 | entryConflictMessage(conflict, `'regular'`) | DUPLICATE_CLASS_SLOT | EC:342 / EC:345 | C:211 | **BOTH**: a replay after commit collides with its own new draft entry; also any other live entry | USER | tC:1524-1525 S+C (sequential replay); tC:1534-1537 S+C; tC:1566-1569 S+C; tX:237 S+C+M(exact-string regex); tX:526 S+C+M(regex); tX:553-554 S+C+M(exact) |

**C. Replay:** 409 DUPLICATE_CLASS_SLOT `You already have a class at HH:MM on D Mon YYYY.` The entry insert skips because the first call's live draft entry overlaps (C:140-151), then the route probes and answers (C:198-211). Pinned by tC:1519-1525. The client blocks a resend after success with `createdId` (page.tsx:320).

**Out of scope:** 5.

---

## 5. PUT /api/classes/[id]

**A. Client callers**
- `src/components/class/class-edit-form.tsx:117`. Custom parse (`json.error` as string or `.message`, :126-128). Red `role="alert"` text :265. Calls `router.refresh()` on refusal (:137).

**B.**

| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Class not found` | — | Ci:66; Ci:100 (CL:1358, 1609, 1664) | Ci:66, Ci:100 | GENUINE | USER | none |
| 403 | `Not your class` | — | Ci:68 | Ci:68 | GENUINE | USER | tC:934-939 S+M(contains) |
| 409 | `` `Cannot update economic fields when settings are locked: ${result.fields.join(', ')}` `` | — | Ci:104 (CL:1502, 1680) | Ci:103 | GENUINE (a registration in between locks the class) | DEV (interpolates field names such as `roomCost`) | tC:875-886 S+M(contains field names); tC:902 S |
| 409 | `` `Cannot edit a class that is ${result.state}` `` | CLASS_TERMINAL | Ci:120 (CL:1375, 1673; state is `completed` or `cancelled`) | Ci:120 | GENUINE | DEV (interpolates a status value, which happens to read as English) | tC:1118-1122 S+M(contains `completed`)+C; tC:1147-1154 S+M(contains `cancelled`)+C |
| 409 | `This class was completed or cancelled while you were editing it, so its schedule can no longer change.` | CLASS_SCHEDULE_FROZEN | Ci:147 (CL:1588) | Ci:146 | GENUINE | USER | none (service-level only: `src/services/class-lifecycle.test.ts` ~2006) |
| 409 | entryConflictMessage(conflict, `'regular'`) | DUPLICATE_CLASS_SLOT | EC:342/345 (reason CL:1621-1622) | Ci:191-195 | GENUINE (the constraint ignores the row's own span; the probe passes `excludeEntryId`, Ci:176) | USER | tC:995-997 S+C; tX:246-248 S+C+M(exact regex) |
| 409 | `That recurring class already has a class on that date.` | TEMPLATE_INSTANCE_DATE_CONFLICT | Ci:205 (CL:1630-1631) | Ci:204 | GENUINE | USER | tC:1095-1098 S+C+M(exact) |
| 409 | `Cannot move a class to a date and time that has already passed.` | CLASS_STARTS_IN_PAST | Ci:219 (CL:1489) | Ci:218 | GENUINE (a replay does not move the start, CL:1449-1452) | USER | tC:950-955 S+C |

**C. Replay:** 200. The start does not move, so `movesStart` is false. The CAS writes the same values while the class is still unlocked (CL:1439-1611). A registration arriving between the two calls turns the replay into the `locked` 409.

**Out of scope:** 6 (3 auth + 2 parseBody + 400 `No valid fields to update` at Ci:101, from CL:1536).

---

## 6. POST /api/classes/[id]/cancel

**A. Client callers**
- `src/components/class/cancel-class-button.tsx:29`. `readErrorMessage` :35, red `role="alert"` text :72.

**B.**

| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Class not found` | — | Ccan:46 (pre-read); Ccan:93 (in-transaction re-read after a missed CAS) | Ccan:46; Ccan:168 | GENUINE | USER | tC:761-765 S+M(exact) for the :93 arm; the :46 arm is untested |
| 403 | `Not your class` | — | Ccan:48 | Ccan:48 | GENUINE | USER | none |
| 409 | `This class is already cancelled.` | — | Ccan:103 | Ccan:168 | **ALREADY** | USER | tC:788-797 S+M(contains). This is a literal replay: tC:480 cancels the same `cancelClassId` first |
| 409 | `` `Cannot cancel a class with status "${current.status}"` `` | — | Ccan:109 (status is `in_progress` or `completed`) | Ccan:168 | GENUINE | DEV (interpolates an enum value) | none |

**C. Replay:** 409 `This class is already cancelled.` The CAS on `cancelledAt: null` misses, and the re-read finds `cancelledAt` set (Ccan:66-105). No second round of notifications is sent.

**Out of scope:** 3 (auth only; the route takes no body).

---

## 7. POST /api/classes/[id]/complete

**A. Client callers**
- `src/components/class/complete-class-button.tsx:20`. `readErrorMessage` :31, red `role="alert"` text :50.

**B.** Every service failure is relayed as `respondError(result.error, 409)` with no code (Ccom:33).

| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Class not found` | — | Ccom:25 | Ccom:25 | GENUINE | USER | tC:358-360 S |
| 403 | `Not your class` | — | Ccom:27 | Ccom:27 | GENUINE | USER | tC:363-365 S |
| 409 | `` `Class not found: ${classId}` `` | — | CL:714 | Ccom:33 | GENUINE (class deleted between the route's read and the lock) | DEV (raw id; the status contradicts the message) | none |
| 409 | `` `Class ${classId} is cancelled` `` | — | CL:721 | Ccom:33 | GENUINE | DEV (raw id) | none (service-level only, `class-lifecycle.test.ts:1055`) |
| 409 | `` `Invalid transition: cannot move from "${from}" to "${to}". Valid transitions from "${from}": [${VALID_TRANSITIONS[from].join(', ')}]` `` | — | CL:248 (via CL:770-771) | Ccom:33 | **BOTH**: a replay reads `from "completed"`; a draft is genuinely refused | DEV (enum values, bracket list, "Invalid") | tC:372-378 S+M(contains `cannot move from "draft" to "completed"`) |

`NOT_ENDED_YET` (CL:751-755) cannot be reached here, because the route passes `finishedEarly: true` (Ccom:32, CL:738). The `open` branch's `validateTransition('open','in_progress')` (CL:761-762) always passes.

**C. Replay:** 409 `Invalid transition: cannot move from "completed" to "completed". Valid transitions from "completed": []`. The class row is locked and re-read as `completed`, then `validateTransition` fails (CL:691, CL:769-771). No duplicate payments are created.

**Out of scope:** 3 (auth only).

---

## 8. POST /api/classes/[id]/transition

**A. Client callers**
- `src/components/class/publish-class-button.tsx:20`. It only ever sends `{status:'open'}`. `readErrorMessage` :33, red `role="alert"` text :62, and it calls `router.refresh()` on refusal (:43). No client sends `draft` or `in_progress` (only tests, e.g. tC:432 and `tests/integration/registrations-api.test.ts:441`).

**B.** Service refusals go through `TRANSITION_FAILURE_RESPONSE` (Ctr:48-59) and are relayed at Ctr:85 as `respondError(result.error, httpStatus, code)`.

| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Class not found` | — | Ctr:74 | Ctr:74 | GENUINE | USER | tC:418-420 S |
| 403 | `Not your class` | — | Ctr:76 | Ctr:76 | GENUINE | USER | tC:423-425 S |
| 404 | `` `Class not found: ${classId}` `` | NOT_FOUND (Ctr:52) | CL:591 | Ctr:85 | GENUINE | DEV (raw id) | none (service-level only, `class-lifecycle.test.ts:621`) |
| 409 | `` `Class ${classId} is cancelled` `` | CLASS_CANCELLED (Ctr:58) | CL:601 | Ctr:85 | GENUINE | DEV (raw id) | none |
| 409 | `Invalid transition: …` (template as in pair 7) | ILLEGAL_TRANSITION (Ctr:53) | CL:248 (via CL:605-606) | Ctr:85 | **BOTH**: a publish replay reads `from "open" to "open"`; draft→in_progress is genuinely refused | DEV | tC:432-438 S+M(contains `cannot move from "draft" to "in_progress"`); no code asserted |
| 409 | `` `Concurrent modification of class ${classId}` `` | CONCURRENT_MODIFICATION (Ctr:55) | CL:614 | Ctr:85 | GENUINE (a double change mid-request) | DEV (raw id, jargon) | none (service-level only: `class-lifecycle.test.ts`, `transition-class-lock-order.test.ts`) |
| 409 | `Cannot publish a class whose start time has already passed.` | CLASS_STARTS_IN_PAST (Ctr:56) | CL:502 | Ctr:85 | GENUINE (fires only while the class is still `draft`, CL:462) | USER | tC:458-473 S+C+M(regex) |
| 409 | `This room is archived. Unarchive it to publish classes here.` | ROOM_ARCHIVED (Ctr:57) | CL:314 (returned at CL:456 and CL:577) | Ctr:85 | GENUINE | USER | none (service-level only: `src/services/room-archive-doors.test.ts:47-48`, `src/services/class-room-race.test.ts:164`) |

`NOT_ENDED_YET` → `CLASS_NOT_ENDED_YET` (Ctr:54) is in the map but cannot be reached through this route, because `transitionClass` never returns that reason (CL:358-366).

**C. Replay of `{status:'open'}`:** 409 ILLEGAL_TRANSITION `Invalid transition: cannot move from "open" to "open". Valid transitions from "open": [in_progress]`. The step by step:
1. The pre-checks are skipped because `open` is not in `sourceStatesFor('open')` (CL:441-463).
2. The CAS misses (CL:544-552).
3. The re-read finds the class not cancelled, so `validateTransition` fails (CL:587-606).

PublishClassButton shows this text in red and then refreshes.

**Out of scope:** 5 (3 auth + 2 parseBody; `completed` is rejected by the schema, tC:444-450).

---

## 9. POST /api/studio-class-templates

**A. Client callers**
- `src/components/settings/studio-template-form.tsx:165`. URL :147. `readErrorMessage` :177, red `role="alert"` text :417.

**B.**

| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 409 | `You already have a recurring studio class at an overlapping time on that day.` | DUPLICATE_STUDIO_TEMPLATE_SLOT | ST:29-30 (STL:768-775) | ST:77 | **BOTH** (a replay collides with its own new rule) | USER | tS:308-309 S+C (sequential replay); tS:343-346 S+C (concurrent) |
| 409 | `You already have a recurring class at an overlapping time on that day.` | CROSS_FAMILY_CLASS_TEMPLATE_SLOT | ST:33-34 | ST:77 | GENUINE | USER | tS:416-421 S+C+M(regex); tS:447-449 S+C; tX:326-328 S+C+M(regex) |
| 409 | SLOT_TAKEN.unknown sentence | STUDIO_TEMPLATE_SLOT_CONFLICT | ST:37-38 | ST:77 | **BOTH** (after commit only if the probe throws) | USER | none |
| 503 | `The system was busy and could not create this recurring studio class. Nothing was created. Wait a moment, then try again.` | STUDIO_TEMPLATE_BUSY | ST:81 (STL:758-763) | ST:80 | GENUINE (transient) | USER | none |

**C. Replay:** 409 DUPLICATE_STUDIO_TEMPLATE_SLOT (STL:714-728, 768-775; ST:71-77). Pinned by tS:298-309.

**Out of scope:** 5.

---

## 10. PUT /api/studio-class-templates/[id]

**A. Client callers**
- `src/components/settings/studio-template-form.tsx:165`. URL :148 and method PUT :149 in edit mode. `readErrorMessage` :177, red `role="alert"` text :417.

**B.**

| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Studio class template not found` | — | STi:129 (RL:1644, 1742) | STi:129 | GENUINE | DEV? (model name "template") | tS:603-610 S |
| 403 | `Access denied` | — | STi:130 (RL:1645) | STi:130 | GENUINE | DEV? | tS:499-514 S (loop); tS:636-637 S |
| 409 | `You already have a recurring studio class at an overlapping time on that day.` | DUPLICATE_STUDIO_TEMPLATE_SLOT | STi:35-36 (RL:1745-1762) | STi:138-139 | GENUINE (`excludeRuleId`) | USER | tS:550-552 S+C |
| 409 | `You already have a recurring class at an overlapping time on that day.` | CROSS_FAMILY_CLASS_TEMPLATE_SLOT | STi:39-40 | STi:138-139 | GENUINE | USER | tS:482-485 S+C+M(regex); tX:339-341 S+C+M(regex) |
| 409 | SLOT_TAKEN.unknown sentence | STUDIO_TEMPLATE_SLOT_CONFLICT | STi:43-44 | STi:138-139 | GENUINE | USER | uST:44-49 S+C+M(exact) |
| 503 | `The system was busy and could not edit this recurring studio class. Nothing was changed. Wait a moment, then try again.` | STUDIO_TEMPLATE_BUSY | STi:143 (RL:1734) | STi:142 | GENUINE (transient) | USER | tS:666-670 S+C+M(contains) |

The `invalid_room` reason throws `Error('Unreachable…')` (STi:148-151), which would surface as the generic 500. It is not counted as a row.

**C. Replay:** 200 with the same values (RL:1674-1826; `excludeRuleId` at RL:1756).

**Out of scope:** 6 (3 auth + 2 parseBody + 400 `No valid fields to update` at STi:131).

---

## 11. PATCH /api/studio-class-templates/[id] (`?state=`)

**A. Client callers**
- `src/components/settings/toggle-studio-template-button.tsx:33`. `readErrorMessage` :69, red `role="alert"` text :88.
- `src/components/settings/archive-studio-template-button.tsx:31`. `readErrorMessage` :67, red `role="alert"` text :86.

**B.**

| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Studio class template not found` | — | STi:221 (RL:405, 521, 626), STi:290 (RL:1103, 1474) | same | GENUINE | DEV? | none |
| 403 | `Access denied` | — | STi:222, STi:291 (RL:406, 1104) | same | GENUINE | DEV? | tS:499-514 S (`?state=paused`) |
| 409 | studio sentence (unarchive only) | DUPLICATE_STUDIO_TEMPLATE_SLOT | STi:35-36 (RL:884-896) | STi:228-229 | GENUINE | USER | tS:991-993 S+C |
| 409 | class sentence (unarchive only) | CROSS_FAMILY_CLASS_TEMPLATE_SLOT | STi:39-40 | STi:228-229 | GENUINE | USER | tX:352-354 S+C+M(regex) |
| 409 | unknown sentence (unarchive only) | STUDIO_TEMPLATE_SLOT_CONFLICT | STi:43-44 | STi:228-229 | GENUINE | USER | none |
| 503 | `` `The system was busy and could not ${state === 'archived' ? 'archive' : 'unarchive'} this recurring studio class. Nothing was changed. Wait a moment, then try again.` `` | STUDIO_TEMPLATE_BUSY | STi:233 (RL:672, RL:867) | STi:232 | GENUINE (transient or reversed) | USER | tS:1213-1217 S+C+M(contains), unarchive |
| 409 | `Unarchive the template before activating it` | — | STi:300 (RL:1129, 1476) | STi:300 | GENUINE | DEV? | tS:942-943 S |
| 503 | `The system was busy and could not update this recurring studio class. Nothing was changed. Wait a moment, then try again.` | STUDIO_TEMPLATE_BUSY | STi:304 (RL:1438, 1478) | STi:303 | GENUINE (transient) | USER | tS:1244-1250 S+C+M(contains) |

**Relies on a generic fallback:** same as pair 3. The resume path's `CalendarEntry_teacher_slot_excl` is rethrown (RL:1444-1450) and answered 409 with no code (`api-errors.ts:567-573`).

**C. Replay:** 200 `unchanged` (RL:426-432, RL:1115-1121). Pinned by tS:1089-1147.

**Out of scope:** 4 (3 auth + 400 state query at STi:188).

---

## 12. POST /api/studio-classes

**A. Client callers**
- `src/app/(teacher)/studio-class/new/page.tsx:137`. Custom parse (`json.error?.message`, :144-145). Red `role="alert"` text :189.

**B.**

| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 409 | entryConflictMessage(conflict, `'studio'`) | DUPLICATE_STUDIO_SLOT | EC:342/345 | SC:129 | **BOTH** (a replay collides with its own new entry) | USER | tS:2036-2037 S+C (sequential replay); tS:2073-2076 S+C; tX:296 S+C+M(exact regex); tX:480-481 S+C+M(exact); tX:501-502 S+C+M(exact); tX:531 S+C+M(regex) |

**C. Replay:** 409 DUPLICATE_STUDIO_SLOT `You already have a studio class at HH:MM on …` (SC:87-98, 111-129). Pinned by tS:2031-2037. The client blocks a resend after success with `createdId` (page.tsx:162).

**Out of scope:** 5.

---

## 13. PUT /api/studio-classes/[id]

**A. Client callers**

| caller | how the error is read | how it is shown |
|---|---|---|
| `src/components/studio-class/studio-class-edit-form.tsx:184` | `readErrorMessage` :193 | red `role="alert"` span (:291-292); calls `router.refresh()` when answered (:217) |
| `src/components/studio-class/cancel-studio-class-button.tsx:22` (sends `{cancelledAt: now}`) | `readErrorMessage` :35 | red `role="alert"` text :67 |
| `src/components/studio-class/restore-studio-class-button.tsx:20` (sends `{cancelledAt: null}`) | `readErrorMessage` :28 | red `role="alert"` text :47 |
| `src/components/studio-class/student-count-editor.tsx:26` (sends `{studentCount}`) | `readErrorMessage` :40 | red `type-caption text-danger` span with **no** `role="alert"` (:65-66) |

**B.**

| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Studio class not found` | — | SCi:80 | SCi:80 | GENUINE | USER | none |
| 403 | `Access denied` | — | SCi:82 | SCi:82 | GENUINE | DEV? | tS:1504-1513 S (loop) |
| 409 | `This class is in the past, so only its student count and cancellation can still change.` | STUDIO_CLASS_INCOME_RECORD | SCER:24-25 | SCi:118-122 (gate 1), SCi:141 (gate 2, past row sent a `date`) | **BOTH**, but only across the teacher's local midnight: a same-day schedule edit commits, and a replay after midnight finds the row now past | USER | tS:1770-1773 S+C+M(contains); tS:1786-1788 S+C; tS:1940-1943 S+C+M(not-match) (gate-2 arm) |
| 409 | `This class comes from a recurring template, so it cannot move to another date. Cancel it and log a manual class on the new date instead.` | STUDIO_CLASS_GENERATED_DATE | SCER:28-30 | SCi:141 | GENUINE | USER | tS:1814-1817 S+C+M(contains); tS:1923-1924 S+C |
| 409 | `A class cannot move to a date in the past — it would become an income record and could not be edited again. Log a separate class on that date instead.` | STUDIO_CLASS_PAST_DATE | SCER:40-42 | SCi:157-161 | GENUINE (after midnight, gate 1 or gate 2 answers first) | USER | tS:1963-1966 S+C+M(regex) |
| 409 | entryConflictMessage(conflict, `'studio'`) | DUPLICATE_STUDIO_SLOT | EC:342/345 | SCi:303-307 | GENUINE (the entry never conflicts with itself; the probe passes `excludeEntryId`, SCi:284) | USER | tS:1666-1668 S+C; tS:1684-1686 S+C; tS:1830-1832 S+C; tS:1890-1893 S+C+M(exact); tX:305-307 S+C+M(exact regex); tX:316-318 S+C+M(exact regex) |

**C. Replay:** 200 in every case. The gates read the stored row, which is unchanged except across midnight, and the write repeats the same values (SCi:100-257). The cancel button sends a fresh `new Date()` on each click, so two clicks are not identical requests. A byte-identical replay stores the same clamped timestamp (SCi:192-197).

**Out of scope:** 6 (3 auth + 2 parseBody + 400 `No valid fields to update` for an empty body at SCi:89).

---

## 14. DELETE /api/studio-classes/[id]

**A. Client callers**
- `src/components/studio-class/delete-studio-class-button.tsx:69`. `readErrorMessage` :71, red `role="alert"` text :120. On success it does a hard navigation (:90), so the client never sends a second request.

**B.**

| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Studio class not found` | — | SCi:354 | SCi:354 | **BOTH**: a replay after commit gets this; so does an id that never existed | USER | tS:2130-2134 S (unknown id); tS:2280-2281 S (sequential replay) |
| 403 | `Access denied` | — | SCi:356 | SCi:356 | GENUINE | DEV? | tS:2121-2124 S |
| 409 | `This class comes from a recurring template and is not yet past, so removing it would only create it again. Cancel it instead.` | STUDIO_CLASS_REGENERATES | SCD:165-167 | SCi:382 | GENUINE | USER | tS:2142-2145 S+C+M(contains); tS:2163 S; tS:2231 S; tS:2258-2260 S+C |
| 404 | `That class is already gone.` | — | SCi:407 | SCi:407 | **ALREADY** (a concurrent removal committed between the read and the delete) | USER | none |

**C. Replay:** 404 `Studio class not found`, because the entry was deleted and the child row went with it in the cascade (SCi:347-354, 390). Pinned by tS:2278-2281 (status only).

**Out of scope:** 3 (auth only).

---

## Summary

**Pairs:** 14 in the tabulated group.
- Every tabulated pair has at least one client caller.
- The 5 cron pairs have no client caller: POST `/api/cron/daily-cleanup`, POST `/api/cron/email-fallback`, POST `/api/cron/generate-classes`, POST `/api/cron/payment-reminders`, POST `/api/cron/transition-classes`. The grep for `api/cron` outside `src/app/api/cron` finds only comments.

**In-scope rows: 79.** Per pair: 6, 8, 9, 2, 8, 4, 5, 8, 4, 6, 8, 1, 6, 4. By register: **DEV 13**, **DEV? 12**, **USER 54**.

DEV rows (13):
- POST /api/class-templates — 400 — `Invalid teacher room`
- PUT /api/class-templates/[id] — 400 — `Invalid teacher room`
- POST /api/classes — 400 — `Invalid teacher room`
- PUT /api/classes/[id] — 409 — `Cannot update economic fields when settings are locked: ${fields}`
- PUT /api/classes/[id] — 409 — `Cannot edit a class that is ${state}`
- POST /api/classes/[id]/cancel — 409 — `Cannot cancel a class with status "${status}"`
- POST /api/classes/[id]/complete — 409 — `Class not found: ${classId}`
- POST /api/classes/[id]/complete — 409 — `Class ${classId} is cancelled`
- POST /api/classes/[id]/complete — 409 — `Invalid transition: cannot move from "${from}" to "${to}". Valid transitions from "${from}": [...]`
- POST /api/classes/[id]/transition — 404 — `Class not found: ${classId}`
- POST /api/classes/[id]/transition — 409 — `Class ${classId} is cancelled`
- POST /api/classes/[id]/transition — 409 — `Invalid transition: …`
- POST /api/classes/[id]/transition — 409 — `Concurrent modification of class ${classId}`

DEV? rows (12):
- PUT /api/class-templates/[id] — 404 — `Class template not found`
- PUT /api/class-templates/[id] — 403 — `Access denied`
- PATCH /api/class-templates/[id] — 404 — `Class template not found`
- PATCH /api/class-templates/[id] — 403 — `Access denied`
- PATCH /api/class-templates/[id] — 409 — `Unarchive the template before activating it`
- PUT /api/studio-class-templates/[id] — 404 — `Studio class template not found`
- PUT /api/studio-class-templates/[id] — 403 — `Access denied`
- PATCH /api/studio-class-templates/[id] — 404 — `Studio class template not found`
- PATCH /api/studio-class-templates/[id] — 403 — `Access denied`
- PATCH /api/studio-class-templates/[id] — 409 — `Unarchive the template before activating it`
- PUT /api/studio-classes/[id] — 403 — `Access denied`
- DELETE /api/studio-classes/[id] — 403 — `Access denied`

**Codes:** 47 rows carry a code and 32 do not.

The uncoded rows are:
- every 404 and 403 in the group except transition's service `NOT_FOUND`;
- all three `Invalid teacher room`;
- both `Unarchive the template…`;
- `locked`;
- all of the cancel route's refusals;
- all of the complete route's refusals;
- `That class is already gone.`

Codes seen on rows: ROOM_ARCHIVED, DUPLICATE_TEMPLATE_SLOT, CROSS_FAMILY_STUDIO_TEMPLATE_SLOT, TEMPLATE_SLOT_CONFLICT, TEMPLATE_BUSY, DUPLICATE_CLASS_SLOT, CLASS_TERMINAL, CLASS_SCHEDULE_FROZEN, TEMPLATE_INSTANCE_DATE_CONFLICT, CLASS_STARTS_IN_PAST, NOT_FOUND, CLASS_CANCELLED, ILLEGAL_TRANSITION, CONCURRENT_MODIFICATION, DUPLICATE_STUDIO_TEMPLATE_SLOT, CROSS_FAMILY_CLASS_TEMPLATE_SLOT, STUDIO_TEMPLATE_SLOT_CONFLICT, STUDIO_TEMPLATE_BUSY, DUPLICATE_STUDIO_SLOT, STUDIO_CLASS_INCOME_RECORD, STUDIO_CLASS_GENERATED_DATE, STUDIO_CLASS_PAST_DATE, STUDIO_CLASS_REGENERATES.

**No client caller in this group reads a code.** Every caller uses `readErrorMessage` or a custom `.message` parse. A grep for `readError(` and `error?.code` / `error.code` across these components and pages found no hits in them.

**ALREADY or BOTH: 12 rows (2 ALREADY, 10 BOTH).**
- ALREADY: POST /api/classes/[id]/cancel — 409 `This class is already cancelled.`
- ALREADY: DELETE /api/studio-classes/[id] — 404 `That class is already gone.`
- BOTH: POST /api/class-templates — 409 DUPLICATE_TEMPLATE_SLOT
- BOTH: POST /api/class-templates — 409 TEMPLATE_SLOT_CONFLICT (replay path only when the probe throws)
- BOTH: POST /api/classes — 409 DUPLICATE_CLASS_SLOT
- BOTH: POST /api/classes/[id]/complete — 409 `Invalid transition …` (replay reads `from "completed"`)
- BOTH: POST /api/classes/[id]/transition — 409 ILLEGAL_TRANSITION (publish replay reads `from "open" to "open"`)
- BOTH: POST /api/studio-class-templates — 409 DUPLICATE_STUDIO_TEMPLATE_SLOT
- BOTH: POST /api/studio-class-templates — 409 STUDIO_TEMPLATE_SLOT_CONFLICT (probe-throws only)
- BOTH: POST /api/studio-classes — 409 DUPLICATE_STUDIO_SLOT
- BOTH: PUT /api/studio-classes/[id] — 409 STUDIO_CLASS_INCOME_RECORD (only across local midnight)
- BOTH: DELETE /api/studio-classes/[id] — 404 `Studio class not found`

**Every distinct code string in the group (24), with where it is written:**

| code | written at |
|---|---|
| ROOM_ARCHIVED | CT:91, CT:119; CTi:72; Ctr:57 (map). CL:455 and CL:576 use the same string as the service *reason* |
| DUPLICATE_TEMPLATE_SLOT | CT:37; CTi:49 |
| CROSS_FAMILY_STUDIO_TEMPLATE_SLOT | CT:41; CTi:53 |
| TEMPLATE_SLOT_CONFLICT | CT:45; CTi:57 |
| TEMPLATE_BUSY | CT:137; CTi:113, CTi:405, CTi:527 |
| DUPLICATE_STUDIO_TEMPLATE_SLOT | ST:30; STi:36 |
| CROSS_FAMILY_CLASS_TEMPLATE_SLOT | ST:34; STi:40 |
| STUDIO_TEMPLATE_SLOT_CONFLICT | ST:38; STi:44 |
| STUDIO_TEMPLATE_BUSY | ST:83; STi:145, STi:235, STi:306 |
| DUPLICATE_CLASS_SLOT | C:211; Ci:194 |
| CLASS_TERMINAL | Ci:120 |
| CLASS_SCHEDULE_FROZEN | Ci:149 |
| TEMPLATE_INSTANCE_DATE_CONFLICT | Ci:207 |
| CLASS_STARTS_IN_PAST | Ci:221; Ctr:56 |
| NOT_FOUND | Ctr:52 |
| ILLEGAL_TRANSITION | Ctr:53 (also the service reason, CL:247) |
| CLASS_NOT_ENDED_YET | Ctr:54 (cannot be reached through this route) |
| CONCURRENT_MODIFICATION | Ctr:55 (also the service reason, CL:613) |
| CLASS_CANCELLED | Ctr:58 |
| DUPLICATE_STUDIO_SLOT | SC:129; SCi:306 |
| STUDIO_CLASS_INCOME_RECORD | SCER:25 |
| STUDIO_CLASS_GENERATED_DATE | SCER:30 |
| STUDIO_CLASS_PAST_DATE | SCER:42 |
| STUDIO_CLASS_REGENERATES | SCD:167 |

**Surprises and contradictions**

1. **The complete route answers `NOT_FOUND` as 409 `Class not found: <id>`** (Ccom:33 relays every failure with status 409 and no code). The transition route's docblock (Ctr:17-20) says exactly this status/message contradiction was fixed, but the fix exists only in the transition route. Complete also sends no code for any refusal.
2. **Publishing twice (the natural double-click) shows the teacher a developer string.** The replay gets `Invalid transition: cannot move from "open" to "open". Valid transitions from "open": [in_progress]`, and PublishClassButton renders it in red. Completing twice does the same with `from "completed" … []`. Of this group's three class-lifecycle doors, only cancel answers a replay in user copy.
3. **One condition, two 404 messages on the transition route.** The route's own read answers `Class not found` with no code (Ctr:74). The service's re-read answers `Class not found: <id>` with code NOT_FOUND (CL:591).
4. **Ownership refusal wording differs by family.** The class routes say `Not your class`; the template and studio routes say `Access denied`.
5. **POST /api/class-templates likely answers a deleted room with "This room is archived".** Found by reading the code only; not measured and not tested. A room deleted between the pre-check (CT:73) and the insert trips `CLASS_TEMPLATE_ROOM_FK`, which is caught at CT:110. PUT fixed this same wrong sentence with a re-read (#231, CTi:252-263); POST has no re-read. A room with no classes or templates can still be deleted, so this is reachable for a room's first template.
6. **The TEMPLATE_BUSY / STUDIO_TEMPLATE_BUSY 503 (`The system was busy…`) is also sent for a state change, not only for lock contention.** When the archive CAS misses and the re-read shows a third request reversed the transition, the service returns `busy` (RL:640-672).
7. **Resume (`?state=active`) deliberately leans on the generic fallback** for `CalendarEntry_teacher_slot_excl` (RL:1441-1450). The teacher gets 409 `You already have a class or studio class at an overlapping time on that date.` with no code.
8. **Small correction to the background.** It calls `classifyApiError`'s fallbacks "generic". The two slot-exclusion fallbacks (`api-errors.ts:552-574`) and the terminal-trigger fallback (`That class can no longer be changed`, :489) now carry product sentences. The background is right that none of them carries a code: `withErrorHandler` drops it (`api-utils.ts:160`).
9. **Three callers parse the error body by hand instead of using `readErrorMessage`:** `class/new/page.tsx:303`, `class-edit-form.tsx:126` and `studio-class/new/page.tsx:144`. Each shows the same `.message` as the helper would. The two create pages throw on a non-JSON body, and their catch then shows generic network copy.
10. **Two error displays differ from the rest.** `student-count-editor.tsx:65-66` shows its error without `role="alert"`. The transition route accepts `draft` and `in_progress`, but no client sends them.
11. **Several refusals have no HTTP-level test at all:**
    - transition: ROOM_ARCHIVED, CLASS_CANCELLED, CONCURRENT_MODIFICATION and service NOT_FOUND;
    - complete: `Class <id> is cancelled` and `Class not found: <id>`;
    - cancel: 403 and `Cannot cancel a class with status …`;
    - PUT class: CLASS_SCHEDULE_FROZEN and 404;
    - both template creates: TEMPLATE_BUSY / STUDIO_TEMPLATE_BUSY;
    - both template families' PATCH: 404;
    - DELETE studio: `That class is already gone.`

    Messages in the class-lifecycle family are asserted mostly by substring. `ILLEGAL_TRANSITION`'s code is never asserted over HTTP.
