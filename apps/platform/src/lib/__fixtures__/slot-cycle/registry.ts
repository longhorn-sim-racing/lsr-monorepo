import { joinSlots } from "../../slots"
import { ITEMS } from "./slot"

/** Test fixture for slots.test.ts: a registry whose slot file imports it back (the mistake joinSlots catches) */
export const ALL_ITEMS = joinSlots("fixture item", { groundwork: ITEMS }, (item) => item.id)

export function findItem(id: string) {
  return ALL_ITEMS.find((item) => item.id === id)
}
