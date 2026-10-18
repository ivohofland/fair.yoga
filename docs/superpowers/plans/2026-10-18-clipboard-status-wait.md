# Wait for the clipboard status text, not its element (#903)

**Goal:** the `PaymentDetails` copy tests wait for the status message itself, so they
cannot assert on the empty live region before the clipboard promise settles.

## Premise, measured

- `CopyFieldList` (`src/components/student/copy-field-list.tsx`) always renders its
  `<p role="status">`, empty until a copy settles. `findByRole('status')` therefore
  resolves on the first poll, and the chained `toHaveTextContent` runs once, unretried.
- The issue names two cases. At `origin/main` (3af485b8), three in `payment-details.test.tsx` have the shape
  `expect(await screen.findByRole('status')).toHaveTextContent(…)`:
  - "confirms the copy on the button that made it…" (`'IBAN copied'`) — **not named in
    the issue**. Its text arrives in `writeText().then`, so it races in the same way.
  - "says so when the clipboard refuses…" — the reported flake; text arrives in `.catch`.
  - "handles a missing clipboard API…" — text is set synchronously inside the click
    handler, which `fireEvent` flushes under `act`, so this one cannot race. Converted
    anyway so the three read alike.
- The same shape elsewhere: `grep -rnE "findByRole\('status'[^)]*\)\)\.(toHaveTextContent|not)" src tests`
  gives, at `origin/main` (3af485b8), 5 hits = 3 here + 2 in
  `src/components/booking/passkey-sign-in.test.tsx`; after this change, 2 (the passkey
  ones). Those are sound: `PasskeySignIn` renders its `role="status"` only once
  `state === 'incomplete'`, so the element arrives with its text.

## Task 1 — rewrite the three assertions

File: `src/components/student/payment-details.test.tsx`.

Replace each `expect(await screen.findByRole('status')).toHaveTextContent(MSG)` with
`expect(await screen.findByText(MSG)).toHaveAttribute('role', 'status')`. `findByText`
retries until the message exists, and the attribute check still pins that it reached the
live region rather than some other node.

Prove it bites:

1. Mutate `stubClipboard` so the spy waits 50 ms before calling through.
2. With the **old** assertions: the success and refusal cases both fail
   ("Expected element to have text content … Received:" — empty).
3. With the **new** assertions under the same delay: 16/16 pass.
4. Remove the mutation; 16/16 pass.

## Task 2 — the same race in `attendance-list.test.tsx` (found in branch review)

The plan's grep keys on `'status'` and a chained `toHaveTextContent`/`.not`, so it cannot see
"surfaces the server's reason for a refusal…" in `src/components/class/attendance-list.test.tsx`:
`const alert = await screen.findByRole('alert'); expect(alert.textContent).toContain(…)`.
`AttendanceList` mounts its `sr-only` `role="alert"` unconditionally, empty until the
refusal lands, so this is the same race under a different role and spelling.

Wait for the text with `waitFor(() => expect(getByRole('alert')).toHaveTextContent(…))`,
then read the element. Proof, delaying that case's fetch mock 50 ms: old assertion fails
with `expected '' to contain 'Once the class has started'`; new one passes; 28/28 without
the delay.

No component change in either task.
