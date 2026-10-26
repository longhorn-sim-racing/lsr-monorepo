import { findItem } from "./registry"

/** Test fixture for slots.test.ts: a slot file that imports its own registry. Don't copy this shape */
export const ITEMS: { id: string; sibling: () => unknown }[] = [{ id: "a", sibling: () => findItem("b") }]
