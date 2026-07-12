// The shared bordered-panel primitive. Three zones need identical chrome —
// the sale status panel (Story 2.2), the form panel, and the verdict panel
// (Story 2.3) — so the borders, radius, shadow, and padding are declared once,
// here, and never re-declared downstream.
//
//   cream         — paper faces: status (active/sold_out), verdict
//   yellow-lifted — the form panel
//   poster        — noon-yellow + 12% ink stripes: the waiting treatment
//                   (upcoming, ended, cold-load). Reading text inside sits on
//                   its own opaque face — stripes never run behind it.
import type { ReactNode } from "react";
import "./Panel.css";

export type PanelVariant = "cream" | "yellow-lifted" | "poster";

export interface PanelProps {
  variant: PanelVariant;
  children: ReactNode;
  className?: string;
  /** Escape hatch for the status panel's overhanging LIVE sticker (Story 2.2). */
  id?: string;
}

export function Panel({ variant, children, className, id }: PanelProps) {
  const classes = ["panel", `panel--${variant}`, className].filter(Boolean).join(" ");
  return (
    <section className={classes} id={id}>
      {children}
    </section>
  );
}
