# Mutation record — studio template forbidden-field pins (issue 114)

Each mutation was applied, the exact error recorded verbatim, the change reverted,
and the suite re-run to green. No mutation was left in place.

## Mutations 1–5: schema / allowlist pins

### Mutation 1 — add `isActive` to schema only

**Change:** `isActive: z.boolean().optional(),` added to
`updateStudioClassTemplateSchema` (`src/lib/schemas.ts`).

**Must fire:** `_studioTemplateFieldsArePermitted` **and** the `server-owned
fields` register.

**Typecheck (verbatim):**
```
src/app/api/studio-class-templates/[id]/route.ts(62,81): error TS2345: Argument of type '{ classType?: string | undefined; dayOfWeek?: number | undefined; startTime?: string | undefined; durationMinutes?: number | undefined; location?: string | undefined; hourlyRate?: number | undefined; isActive?: boolean | undefined; }' is not assignable to parameter of type '{ classType?: string | undefined; dayOfWeek?: number | undefined; startTime?: string | undefined; durationMinutes?: number | undefined; location?: string | undefined; hourlyRate?: number | undefined; isActive?: boolean | undefined; } & Partial<...>'.
  Type '{ classType?: string | undefined; dayOfWeek?: number | undefined; startTime?: string | undefined; durationMinutes?: number | undefined; location?: string | undefined; hourlyRate?: number | undefined; isActive?: boolean | undefined; }' is not assignable to type 'Partial<Record<PlainUpdateForbiddenStudioTemplateField, never>>'.
    Types of property 'isActive' are incompatible.
      Type 'boolean | undefined' is not assignable to type 'undefined'.
        Type 'false' is not assignable to type 'undefined'.
src/components/settings/studio-template-form.tsx(37,7): error TS2322: Type 'true' is not assignable to type '"isActive"'.
src/services/studio-class-template-lifecycle.ts(125,7): error TS2322: Type 'true' is not assignable to type '"isActive"'.
```

**Vitest (verbatim):**
```
AssertionError: A schema declares a server-owned field. Either stop declaring it, or add it to EXPECTED with a reason. See the docblock above.: expected { …(8) } to deeply equal { …(7) }

- Expected
+ Received

@@ -15,9 +15,12 @@
      "status",
    ],
    "updateStudioClassSchema": [
      "cancelledAt",
    ],
+   "updateStudioClassTemplateSchema": [
+     "isActive",
+   ],
    "updateTeacherSchema": [
      "photoUrl",
    ],
  }

 ❯ src/lib/schemas.test.ts:539:7
```

**Reverted, re-run green.** ✅

---

### Mutation 2 — keep #1 and add `isActive` to the allowlist (reflexive repair)

**Change:** `isActive: z.boolean().optional(),` in schema **and**
`| 'isActive'` added to `TeacherEditableStudioTemplateField`.

**Must fire:** `_studioTemplateAllowlistHasNoForbiddenFields`.

**Typecheck (verbatim):**
```
src/app/api/studio-class-templates/[id]/route.ts(62,81): error TS2345: Argument of type '{ classType?: string | undefined; dayOfWeek?: number | undefined; startTime?: string | undefined; durationMinutes?: number | undefined; location?: string | undefined; hourlyRate?: number | undefined; isActive?: boolean | undefined; }' is not assignable to parameter of type '{ classType?: string | undefined; dayOfWeek?: number | undefined; startTime?: string | undefined; durationMinutes?: number | undefined; location?: string | undefined; hourlyRate?: number | undefined; isActive?: boolean | undefined; } & Partial<...>'.
  Type '{ classType?: string | undefined; dayOfWeek?: number | undefined; startTime?: string | undefined; durationMinutes?: number | undefined; location?: string | undefined; hourlyRate?: number | undefined; isActive?: boolean | undefined; }' is not assignable to type 'Partial<Record<PlainUpdateForbiddenStudioTemplateField, never>>'.
    Types of property 'isActive' are incompatible.
      Type 'boolean | undefined' is not assignable to type 'undefined'.
        Type 'false' is not assignable to type 'undefined'.
src/components/settings/studio-template-form.tsx(37,7): error TS2322: Type 'true' is not assignable to type '"isActive"'.
src/services/studio-class-template-lifecycle.ts(250,7): error TS2322: Type 'true' is not assignable to type '"isActive"'.
```

**Reverted, re-run green.** ✅

---

### Mutation 3 — add `notAColumn` to schema and allowlist

**Change:** `notAColumn: z.string().optional(),` in schema **and**
`| 'notAColumn'` in `TeacherEditableStudioTemplateField`.

**Must fire:** `_studioTemplateUpdateColumnsExist`, and only it.

**Typecheck (verbatim):**
```
src/components/settings/studio-template-form.tsx(37,7): error TS2322: Type 'true' is not assignable to type '"notAColumn"'.
src/services/studio-class-template-lifecycle.ts(82,7): error TS2322: Type 'true' is not assignable to type '"notAColumn"'.
```

**Reverted, re-run green.** ✅

---

### Mutation 4 — delete `location` from the allowlist

**Change:** `| 'location'` removed from `TeacherEditableStudioTemplateField`.

**Must fire:** `_studioTemplateFieldsArePermitted` **and**
`_studioTemplateListsPartitionTheModel`.

**Typecheck (verbatim):**
```
src/services/studio-class-template-lifecycle.ts(124,7): error TS2322: Type 'true' is not assignable to type '"location"'.
src/services/studio-class-template-lifecycle.ts(217,7): error TS2322: Type 'true' is not assignable to type '"location"'.
```

**Reverted, re-run green.** ✅

---

### Mutation 5 — delete `location` from the schema

**Change:** `location: z.string().min(1).optional(),` removed from
`updateStudioClassTemplateSchema`.

**Must fire:** `_studioTemplateAllowlistHasNoStaleFields`, and only it.

**Typecheck (verbatim):**
```
src/components/settings/studio-template-form.tsx(39,7): error TS2322: Type 'true' is not assignable to type '"location"'.
src/services/studio-class-template-lifecycle.ts(138,7): error TS2322: Type 'true' is not assignable to type '"location"'.
```

**Reverted, re-run green.** ✅

---

## Mutations 6–8: forbidden-list pins

### Mutation 6 — typo `isActive` → `isActiv`

**Change:** `| 'isActive'` → `| 'isActiv'` in
`PlainUpdateForbiddenStudioTemplateField`.

**Must fire:** `_studioTemplateForbiddenColumnsExist` (names `isActiv`) **and**
`_studioTemplateListsPartitionTheModel` (names `isActive`).

**Typecheck (verbatim):**
```
src/services/studio-class-template-lifecycle.ts(218,7): error TS2322: Type 'true' is not assignable to type '"isActive"'.
src/services/studio-class-template-lifecycle.ts(236,7): error TS2322: Type 'true' is not assignable to type '"isActiv"'.
```

**Reverted, re-run green.** ✅

---

### Mutation 7 — delete `updatedAt` from the forbidden list

**Change:** `| 'updatedAt'` removed from
`PlainUpdateForbiddenStudioTemplateField`.

**Must fire:** `_studioTemplateListsPartitionTheModel`, and only it.

**Typecheck (verbatim):**
```
src/services/studio-class-template-lifecycle.ts(217,7): error TS2322: Type 'true' is not assignable to type '"updatedAt"'.
```

**Reverted, re-run green.** ✅

---

### Mutation 8 — simulate a migration adding `publishedAt`

**Change:** the partition pin's reference changed from
`keyof Prisma.StudioClassTemplateUncheckedUpdateManyInput` to
`keyof (Prisma.StudioClassTemplateUncheckedUpdateManyInput & { publishedAt?: Date | null })`.

**Must fire:** `_studioTemplateListsPartitionTheModel`, naming `publishedAt`.

**Typecheck (verbatim — studio pin):**
```
src/services/studio-class-template-lifecycle.ts(218,7): error TS2322: Type 'true' is not assignable to type '"publishedAt"'.
```

**Class family contrast:** the same `& { publishedAt?: Date | null }` applied to
a local copy of `_templateForbiddenListIsComplete`'s `Exclude` — **tsc exits 0**.
The duplicate-union form is structurally blind to a new column; the partition form
is not. This contrast is the whole claim in spec §A.

**Reverted, re-run green.** ✅

---

## Mutations 9–11: the intersection, the bound, the route

### Mutation 9 — pre-built variable with a forbidden field

**Change:** temporary call site added at the end of
`updateStudioClassTemplate`:
```ts
const patch = { classType: 'Yin', isActive: true };
void updateStudioClassTemplate(prisma, 'x', 'y', patch);
```

**Must fire:** the `data` intersection, naming `isActive`.

**Typecheck (verbatim):**
```
src/services/studio-class-template-lifecycle.ts(397,34): error TS2552: Cannot find name 'prisma'. Did you mean 'Prisma'?
src/services/studio-class-template-lifecycle.ts(397,52): error TS2345: Argument of type '{ classType: string; isActive: boolean; }' is not assignable to parameter of type '{ classType?: string | undefined; dayOfWeek?: number | undefined; startTime?: string | undefined; durationMinutes?: number | undefined; location?: string | undefined; hourlyRate?: number | undefined; } & Partial<...>'.
  Type '{ classType: string; isActive: boolean; }' is not assignable to type 'Partial<Record<PlainUpdateForbiddenStudioTemplateField, never>>'.
    Types of property 'isActive' are incompatible.
      Type 'boolean' is not assignable to type 'undefined'.
```

The first error (`prisma` not found) is expected — the test file imports it, this
module does not. The second error is the intersection binding the caller through
a variable, which is the bypass the intersection exists to close. A fresh object
literal would trip excess-property checking with or without the intersection.

**Reverted, re-run green.** ✅

---

### Mutation 10 — delete `await setLockTimeout(tx)`

**Change:** `await setLockTimeout(tx);` removed from the transaction in
`updateStudioClassTemplate`.

**Must fire:** the `busy` unit test hangs to the test's own 20s timeout,
**not** a budget expiry.

**Outcome:** test hung to **20 007 ms** (the 20s vitest timeout). Without the
lock timeout, the write blocked indefinitely behind the other transaction's row
lock — exactly the "hung test, never a budget expiry" the code comment predicted.
The 10s Prisma budget is not a bound because Prisma checks it at statement
boundaries and "cannot roll back a statement already blocked inside Postgres."

**Reverted, re-run green.** ✅

---

### Mutation 11 — duplicated branch in the route

**Change:** `if (result.reason === 'busy')` changed to
`if (result.reason === 'no_fields')` in the PUT handler, creating a duplicated
branch so `busy` becomes unhandled.

**Must fire:** the `const unhandled: never = result` guard, naming `busy`.

**Typecheck (verbatim):**
```
src/app/api/studio-class-templates/[id]/route.ts(84,7): error TS2367: This comparison appears to be unintentional because the types '"busy"' and '"no_fields"' have no overlap.
src/app/api/studio-class-templates/[id]/route.ts(98,9): error TS2322: Type '{ ok: false; reason: "busy"; }' is not assignable to type 'never'.
```

**Reverted, re-run green.** ✅

---

## Summary

All eleven mutations fired as expected. No mutation failed to fire. The contrast
in mutation 8 confirmed the partition pin's structural advantage over the
duplicate-union form: the studio pin went red naming `publishedAt`; the class
family's twin stayed green under the same simulation.
