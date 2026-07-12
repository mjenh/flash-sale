// The sample product as a 190px keycap face. Static, decorative, zero
// behavior — and aria-hidden, because it carries no information the buyer
// needs (the copy and the status zone do that).
import "./ProductTile.css";

export function ProductTile() {
  return (
    <div className="product-tile" aria-hidden="true">
      <span className="product-tile__mark">K1</span>
    </div>
  );
}
