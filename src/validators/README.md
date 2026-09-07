# Validators

Server-authoritative gameplay validation rules.

## Files

- `GameValidator.js`  
  Validates turn ownership, draw/discard constraints, meld validity (sequence/set), go-down thresholds, add-to-meld legality, and pozzetto rules.

- `index.js`  
  Validator exports.

## Why this layer is critical

Validation here prevents illegal state transitions even if client-side UI logic is bypassed or desynced.
