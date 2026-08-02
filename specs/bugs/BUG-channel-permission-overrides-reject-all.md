# Channel permission overrides reject every non-empty mask

## Reproduce

Call `Vesper.Servers.set_channel_permission_overrides/2` with a valid user override whose allow mask is empty and deny mask contains only `view_channel`. The function returns `{:error, {:invalid_overrides, "allow and deny cannot overlap"}}` even though the bitwise intersection is zero.

## Isolate

`Vesper.Servers.parse_override_entry/2` normalizes the allow and deny masks correctly. Its final `with` clause evaluates `(allow &&& deny) != 0 || {:error, ...}` and then matches that result against `false`.

For a valid non-overlapping pair, the comparison is `false`, so `false || error_tuple` evaluates to the error tuple and the match fails. For an overlapping pair, the expression evaluates to `true` and also fails. Every non-empty parsed override is therefore rejected.

## Hypothesize

1. **Primary: the overlap guard combines a boolean match with an error tuple using the wrong polarity.** Falsification: a zero intersection reaches the success branch without changing mask parsing.
2. **The permission-name map assigns the same bit to allow and deny.** Falsification: the empty allow list normalizes to zero and `view_channel` normalizes to one distinct deny bit.
3. **The user is not a valid server member.** Falsification: the reported error occurs before membership validation and explicitly names mask overlap.

## Verify

Confirmed root cause: the final `with` guard is structurally incapable of matching for either a zero or non-zero intersection. The invariant is that parsing succeeds exactly when `(allow &&& deny) == 0`. The fix must express that condition directly and preserve the existing explicit overlap error.
