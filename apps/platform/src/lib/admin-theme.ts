/** The admin console's light or dark theme (#167), remembered per browser in a cookie so the server renders the right one */
export type AdminTheme = "light" | "dark"

export const ADMIN_THEME_COOKIE = "lsr-admin-theme"

/** Anything but "dark" is light, the default */
export function parseAdminTheme(value: string | undefined | null): AdminTheme {
  return value === "dark" ? "dark" : "light"
}

/** The cookie string that remembers a theme for a year, sent only to admin pages */
export function adminThemeCookie(theme: AdminTheme): string {
  return `${ADMIN_THEME_COOKIE}=${theme}; Path=/admin; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`
}
