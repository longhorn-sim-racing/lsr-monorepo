-- Stand (Haiku 5.5) can answer in a room too, not only do side jobs. Additive: existing rooms keep their persona
ALTER TYPE "JackRoomPersona" ADD VALUE IF NOT EXISTS 'stand';
