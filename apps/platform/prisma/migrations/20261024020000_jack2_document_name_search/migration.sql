-- ---------------------------------------------------------------------------
-- Jack 2.0: document names and folders in search (#188; integration follow-up I2, from T6's note).
--
-- jack2_document_search() indexed a document's name and folder with the default text search parser,
-- which reads a name with an extension, or a folder path, as one token: "Venue Contract.pdf" gave
-- 'venu' and 'contract.pdf', and "Shared/Meeting Notes" gave 'shared/meeting', so `search` missed
-- them by those words. The name and the folder are now also indexed with dots, dashes, underscores
-- and slashes read as spaces. The original tokens stay, so "contract.pdf" still matches too.
--
-- jack2_document_vector() builds a document's whole vector (the trigger and the re-index below share
-- it). The trigger function is replaced in place, so its trigger and its privileges stay as they were.
-- Then every document already synced is indexed again. Only "JackSearchDoc" rows of source 'document'
-- change; the revoke from jack_readonly and the row level security on "JackSearchDoc" stay as they
-- are (checked at the end). ExternalDocument is empty in production until the documents connectors
-- are switched on, so the re-index is one statement.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.jack2_document_vector(p_name text, p_path text, p_text text) RETURNS tsvector
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  v_name text := coalesce(p_name, '');
  v_path text := left(coalesce(p_path, ''), 1000);
  v_name_words text := pg_catalog.regexp_replace(v_name, '[._/-]+', ' ', 'g');
  v_path_words text := pg_catalog.regexp_replace(v_path, '[._/-]+', ' ', 'g');
BEGIN
  RETURN setweight(pg_catalog.to_tsvector('english'::regconfig, v_name), 'A')
    || CASE WHEN v_name_words <> v_name THEN setweight(pg_catalog.to_tsvector('english'::regconfig, v_name_words), 'A') ELSE ''::tsvector END
    || setweight(pg_catalog.to_tsvector('english'::regconfig, v_path), 'B')
    || CASE WHEN v_path_words <> v_path THEN setweight(pg_catalog.to_tsvector('english'::regconfig, v_path_words), 'B') ELSE ''::tsvector END
    || setweight(pg_catalog.to_tsvector('english'::regconfig, left(coalesce(p_text, ''), 100000)), 'C');
END $$;

CREATE OR REPLACE FUNCTION public.jack2_document_search() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM public.jack2_search_put('document', NEW.id, public.jack2_document_vector(NEW.name, NEW.path, NEW.text));
  RETURN NULL;
END $$;

-- Like the other search functions, it only runs inside the trigger (and below)
REVOKE EXECUTE ON FUNCTION public.jack2_document_vector(text, text, text) FROM PUBLIC;

-- Index the documents already synced again
INSERT INTO public."JackSearchDoc" (source, "sourceId", search, "updatedAt")
SELECT 'document', id, public.jack2_document_vector(name, path, text), now() AT TIME ZONE 'UTC'
FROM public."ExternalDocument"
ON CONFLICT (source, "sourceId") DO UPDATE SET search = EXCLUDED.search, "updatedAt" = EXCLUDED."updatedAt";

-- Checks: the new words match, and Jack's SQL role still can't read the index or call the function
DO $check$
BEGIN
  IF NOT public.jack2_document_vector('Venue Contract.pdf', 'Club/Shared/Meeting Notes', NULL) @@ pg_catalog.to_tsquery('english', 'contract & pdf & meeting & shared') THEN
    RAISE EXCEPTION 'jack2_document_vector does not index a name''s or a folder''s words';
  END IF;
  IF NOT public.jack2_document_vector('Venue Contract.pdf', '', NULL) @@ pg_catalog.to_tsquery('english', 'contract.pdf') THEN
    RAISE EXCEPTION 'jack2_document_vector dropped the original file token';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public."JackSearchDoc"'::regclass) THEN
    RAISE EXCEPTION 'row level security is off on "JackSearchDoc"';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jack_readonly') THEN
    IF has_table_privilege('jack_readonly', 'public."JackSearchDoc"', 'SELECT') THEN
      RAISE EXCEPTION 'jack_readonly can read "JackSearchDoc"';
    END IF;
    IF has_function_privilege('jack_readonly', 'public.jack2_document_vector(text, text, text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'jack_readonly can call jack2_document_vector';
    END IF;
  END IF;
END
$check$;
