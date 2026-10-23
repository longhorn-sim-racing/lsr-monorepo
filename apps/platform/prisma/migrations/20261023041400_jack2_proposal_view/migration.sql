-- Jack 2.0 G4 (proposals): the card a kind built when the proposal was made, saved so the card and
-- the proposals route can show it later (the records it describes may have changed since).
-- Additive: one nullable column. JackProposal's RLS policy and jack_readonly's table grant cover it.

-- AlterTable
ALTER TABLE "public"."JackProposal" ADD COLUMN     "view" JSONB;
