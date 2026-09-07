# Domain Models

Core data structures that represent room, player, and cards.

## Files

- `GameRoom.js`  
  Full room state container: players, turn state, deck, discard, melds, dead piles/pozzetto tracking, host info, score snapshots, and ruleset settings.

- `PlayerSession.js`  
  Connection/session state for a player: socket mapping, connectivity, last activity, serialization.

- `Deck.js`  
  `Card` and `Deck` classes, including shuffle/deal/draw logic and card value helpers.

- `index.js`  
  Model exports.

## Design note

Business operations are executed mainly by handlers/services, while model classes hold and expose structured state.
