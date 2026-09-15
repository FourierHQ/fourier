import { cn } from "@/lib/utils";

/**
 * The Fourier mark: three bars, the middle one lifted.
 *
 * The viewBox is the mark's own bounding box rather than the 64×64 square the
 * artwork was drawn in, so the element is exactly as big as the ink and sizes
 * predictably next to text. `brand/mark.svg` keeps the padded square for
 * anywhere that wants it.
 *
 * The mark is 18:25, and an inline SVG will not work its own width out from a
 * height in a flex row — so set both, the way the two components below do.
 */
export function FourierMark({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg viewBox="15 6 36 50" fill="none" aria-hidden="true" className={cn("aspect-[18/25] h-4 w-auto", className)} {...props}>
      <rect x="15" y="14" width="6" height="42" rx="1" fill="currentColor" />
      <rect x="25" y="6" width="9" height="42" rx="1" fill="currentColor" />
      <rect x="38" y="14" width="13" height="42" rx="1" fill="currentColor" />
    </svg>
  );
}

/**
 * The mark on its onyx tile — the same composition as the favicon, so the
 * product looks like its own browser tab.
 */
export function FourierIcon({ className }: { className?: string }) {
  return (
    <div className={cn("flex aspect-square size-8 shrink-0 items-center justify-center rounded-[22%] bg-brand-onyx", className)}>
      <FourierMark className="h-[53%] w-[38%] text-brand-mint" />
    </div>
  );
}

/**
 * Mark and wordmark, in the app's own typeface. Sizes off the current font
 * size, so `text-2xl` scales the whole lockup. The mark stands a little taller
 * than the capitals and is nudged up to sit on their optical centre rather
 * than the line box's; the gap is under the 0.32em the drawn lockups use
 * because the "F" carries its own side bearing into the flex gap.
 *
 * Unlike the tile, this mark sits on the page rather than on onyx, so it takes
 * the legible mint: pure #00FFAE on white is a rumour.
 */
export function FourierLockup({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span className={cn("inline-flex items-center gap-[0.25em] font-semibold leading-none tracking-[-0.02em]", className)} {...props}>
      <FourierMark className="h-[0.86em] w-[0.62em] -translate-y-[0.03em] text-brand-mint-legible" />
      Fourier
    </span>
  );
}
