"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import type { ProductType } from "@prisma/client"
import { toast } from "sonner"
import {
  Button,
  CheckboxField,
  Field,
  FieldGrid,
  FormActions,
  FormSection,
  Input,
  MoneyInput,
  Panel,
  PanelBody,
  PanelFooter,
  SwitchField,
} from "@/components/admin/kit"
import { centsToDollarInput } from "@/lib/money"
import { updateProduct } from "@/server/actions/products"
import type { ProductMetadataFields } from "@/schemas/product.schema"

type EditableProduct = ProductMetadataFields & {
  id: string
  type: ProductType
  name: string
  amountCents: number
  active: boolean
}

export type SeasonOption = {
  slug: string
  /** Season name, or null for a saved slug that isn't a Season. */
  name: string | null
}

type FieldErrors = Record<string, string[] | undefined>

export function ProductEditForm({ product, seasonOptions }: { product: EditableProduct; seasonOptions: SeasonOption[] }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const isLeague = product.type === "LEAGUE_FEE"

  const [name, setName] = useState(product.name)
  const [amount, setAmount] = useState(centsToDollarInput(product.amountCents))
  const [active, setActive] = useState(product.active)
  const [returningAmount, setReturningAmount] = useState(centsToDollarInput(product.returningAmountCents))
  const [returningSeasonSlugs, setReturningSeasonSlugs] = useState(product.returningSeasonSlugs)
  const [requiresMembership, setRequiresMembership] = useState(product.requiresMembership)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})

  const toggleSeason = (slug: string) => {
    setReturningSeasonSlugs((prev) => (prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]))
  }

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    startTransition(async () => {
      const result = await updateProduct(product.id, {
        name,
        amount,
        active,
        returningAmount: isLeague ? returningAmount : "",
        returningSeasonSlugs: isLeague ? returningSeasonSlugs : [],
        requiresMembership: isLeague && requiresMembership,
      })
      if (result.ok) {
        setFieldErrors({})
        toast.success("Product saved")
        router.refresh()
      } else {
        setFieldErrors(result.fieldErrors ?? {})
        toast.error(result.error)
      }
    })
  }

  const error = (field: string) => fieldErrors[field]?.[0]

  return (
    <form onSubmit={onSubmit} className="min-w-0">
      <Panel>
        <PanelBody className="flex flex-col gap-5">
          <FormSection title="Details" description="The name and standard price shown at checkout.">
            <FieldGrid>
              <Field label="Name" htmlFor="name" error={error("name")} required>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!error("name") || undefined} />
              </Field>
              <Field label="Price" htmlFor="amount" error={error("amount")} hint="In US dollars" required>
                <MoneyInput id="amount" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!!error("amount") || undefined} />
              </Field>
            </FieldGrid>
            <SwitchField label="Active" description="Inactive products can't be bought." checked={active} onCheckedChange={setActive} />
          </FormSection>

          {isLeague && (
            <>
              <hr className="border-admin-row" />
              <FormSection title="Returning drivers" description="A lower price for drivers in the standings of a past season.">
                <FieldGrid>
                  <Field
                    label="Returning price"
                    htmlFor="returningAmount"
                    error={error("returningAmount")}
                    hint="Leave blank to charge everyone the standard price. Must be less than the standard price."
                  >
                    <MoneyInput
                      id="returningAmount"
                      placeholder="None"
                      value={returningAmount}
                      onChange={(e) => setReturningAmount(e.target.value)}
                      aria-invalid={!!error("returningAmount") || undefined}
                    />
                  </Field>
                </FieldGrid>
                <Field label="Counts as returning" error={error("returningSeasonSlugs")} hint="Drivers in the standings of any season you tick get the returning price.">
                  {seasonOptions.length === 0 ? (
                    <p className="text-[13px] text-admin-subtle">No seasons exist yet.</p>
                  ) : (
                    <div className="grid max-h-72 grid-cols-1 gap-2.5 overflow-y-auto rounded-md border bg-admin-surface p-3 sm:grid-cols-2">
                      {seasonOptions.map((season) => (
                        <CheckboxField
                          key={season.slug}
                          checked={returningSeasonSlugs.includes(season.slug)}
                          onChange={() => toggleSeason(season.slug)}
                          label={season.name ?? season.slug}
                          description={season.name ? season.slug : "Saved slug, not a season"}
                        />
                      ))}
                    </div>
                  )}
                </Field>
              </FormSection>

              <hr className="border-admin-row" />
              <FormSection title="Entry requirements" description="Checked when a driver starts checkout.">
                <CheckboxField
                  label="Require paid LSR dues before entry"
                  checked={requiresMembership}
                  onChange={(e) => setRequiresMembership(e.target.checked)}
                />
              </FormSection>
            </>
          )}
        </PanelBody>
        <PanelFooter>
          <FormActions note="Changes are recorded in the audit log." className="w-full">
            <Button type="submit" variant="primary" pending={isPending}>
              Save changes
            </Button>
          </FormActions>
        </PanelFooter>
      </Panel>
    </form>
  )
}
