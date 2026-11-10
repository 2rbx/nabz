import Link from "next/link";
import type { Area } from "./area";
import { AreaSwitch } from "./area-switch";
import { NabzLogo } from "./nabz-logo";
import { type NavItem, NavPills } from "./nav";

const AREA_NAV: Record<Area, NavItem[]> = {
  client: [
    { href: "/pulse", label: "Weekly Pulse" },
    { href: "/heatmap", label: "Brand × state" },
  ],
  ops: [
    { href: "/ops/dealers", label: "Dealers" },
    { href: "/ops/batches", label: "Batches" },
    { href: "/ops/calls", label: "Calls" },
    { href: "/ops/voice", label: "Voice agent" },
    { href: "/ops/system", label: "System" },
  ],
};

/**
 * Sticky top bar: logo, the current area's pages as pills, and the Client | Ops switch.
 * Each side of the switch resumes where you left it in this tab (AreaMemory, in the root layout).
 * Below lg the pills move to a second row that scrolls sideways.
 */
export function SiteHeader({ area }: { area: Area }) {
  const items = AREA_NAV[area];
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-surface">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Link
          href={area === "ops" ? "/ops/dealers" : "/pulse"}
          className="flex shrink-0 items-center gap-2"
          aria-label="Nabz home"
        >
          <NabzLogo className="h-6 w-auto" />
        </Link>
        <div className="header-tabs hidden min-w-0 flex-1 justify-center lg:flex">
          <NavPills items={items} ariaLabel={area === "ops" ? "Ops console" : "Main"} />
        </div>
        <div className="ml-auto">
          <AreaSwitch current={area} />
        </div>
      </div>
      <div className="header-tabs border-t border-line-soft lg:hidden">
        <NavPills
          items={items}
          ariaLabel={area === "ops" ? "Ops console" : "Main"}
          className="mx-auto max-w-6xl [mask-image:linear-gradient(to_right,#000_calc(100%-32px),transparent)] px-3 py-2 pr-8"
        />
      </div>
    </header>
  );
}
