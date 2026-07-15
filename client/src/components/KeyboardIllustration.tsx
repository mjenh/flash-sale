// Decorative mechanical keyboard illustration — top-down view, styled to match
// the Noon Poster design language: cream keys, ink borders, hard drop shadow.
// Purely presentational; aria-hidden so screen readers skip it.

export function KeyboardIllustration() {
  const keyW = 36;
  const keyH = 28;
  const gap = 4;
  const rx = 5;
  const xStart = 12;

  // x positions for 14 uniform keys per row
  const xs = Array.from({ length: 14 }, (_, i) => xStart + i * (keyW + gap));

  // y positions for each of the 5 rows
  const rowY = [14, 46, 78, 110, 142];

  // Space row
  const spaceLeft = xStart;
  const modW = keyW;
  const modCount = 3;
  const spaceStart = spaceLeft + modCount * (modW + gap);
  const spaceEnd = 572 - xStart - modCount * (modW + gap);
  const spaceW = spaceEnd - spaceStart - gap;

  return (
    <svg
      viewBox="0 0 580 188"
      xmlns="http://www.w3.org/2000/svg"
      className="kb-illustration"
      aria-hidden="true"
      focusable="false"
    >
      {/* Hard drop shadow */}
      <rect x="8" y="8" width="572" height="180" rx="16" fill="#1a1408" />
      {/* Keyboard body */}
      <rect
        x="0"
        y="0"
        width="572"
        height="180"
        rx="16"
        fill="#fff3d6"
        stroke="#1a1408"
        strokeWidth="3.5"
      />

      {/* Rows 1–4: 14 uniform keys each */}
      {[0, 1, 2, 3].map((row) =>
        xs.map((x, col) => (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: decorative SVG, keys never reorder
            key={`r${row}c${col}`}
            x={x}
            y={rowY[row]}
            width={keyW}
            height={keyH}
            rx={rx}
            fill="#ffffff"
            stroke="#1a1408"
            strokeWidth="1.5"
          />
        ))
      )}

      {/* Space row — left modifiers */}
      {[0, 1, 2].map((i) => (
        <rect
          key={`ml${i}`}
          x={xStart + i * (modW + gap)}
          y={rowY[4]}
          width={modW}
          height={keyH}
          rx={rx}
          fill="#ffdd66"
          stroke="#1a1408"
          strokeWidth="1.5"
        />
      ))}

      {/* Space bar */}
      <rect
        x={spaceStart}
        y={rowY[4]}
        width={spaceW}
        height={keyH}
        rx={rx}
        fill="#ffcf33"
        stroke="#1a1408"
        strokeWidth="1.5"
      />

      {/* Space row — right modifiers */}
      {[0, 1, 2].map((i) => (
        <rect
          key={`mr${i}`}
          x={spaceStart + spaceW + gap + i * (modW + gap)}
          y={rowY[4]}
          width={modW}
          height={keyH}
          rx={rx}
          fill="#ffdd66"
          stroke="#1a1408"
          strokeWidth="1.5"
        />
      ))}
    </svg>
  );
}
