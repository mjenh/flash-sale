-- order.lua — the AD-1 atomic order decision. THE authoritative implementation:
-- membership check, stock check, SADD, DECR execute as one server-side unit
-- (Redis runs scripts single-threaded — nothing interleaves). While the API
-- serves traffic this script is the ONLY writer of orders:{saleId}:users and
-- stock:{saleId}:remaining (ARCHITECTURE-SPINE AD-1). No rollback logic exists.
--
-- ARGV[1] = saleId  (Mongo ObjectId string of the resolved sale — Story 4.2)
-- ARGV[2] = email    (trimmed by the route before it gets here)
--
-- Key names are constructed INSIDE the script from ARGV[1] rather than
-- passed via KEYS[] (Story 4.2 AC2 — a deliberate choice for this
-- single-node deployment; see orders.ts for the cluster-routing trade-off
-- note). No key names are hardcoded — every sale gets its own namespace,
-- so multiple sale records can coexist without collision.
--
-- Reply: { verdict, remaining } — verdict is exactly one of OK | ALREADY |
-- SOLD_OUT; remaining is the stock after this call (post-DECR on OK). Story
-- 1.6 consumes "OK with remaining == 0" to publish sale.sold_out exactly once.
--
-- Missing stock key -> error reply (fail closed, 503 at the API edge): never
-- fabricate a number — 0 would lie "sold out". A flushed Redis lost
-- orders:{saleId}:users too, so no honest ALREADY exists in that state either.
-- Story 1.4's cold-start rebuild makes this state unreachable.
local saleId = ARGV[1]
local ordersKey = 'orders:' .. saleId .. ':users'
local stockKey = 'stock:' .. saleId .. ':remaining'
local stock = tonumber(redis.call('GET', stockKey))
if stock == nil then
  return redis.error_reply(stockKey .. ' missing')
end
if redis.call('SISMEMBER', ordersKey, ARGV[2]) == 1 then
  return { 'ALREADY', stock }
end
if stock <= 0 then
  return { 'SOLD_OUT', stock }
end
redis.call('SADD', ordersKey, ARGV[2])
return { 'OK', redis.call('DECR', stockKey) }
