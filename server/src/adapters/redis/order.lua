-- order.lua — the AD-1 atomic order decision. THE authoritative implementation:
-- membership check, stock check, SADD, DECR execute as one server-side unit
-- (Redis runs scripts single-threaded — nothing interleaves). While the API
-- serves traffic this script is the ONLY writer of orders:users and
-- stock:remaining (ARCHITECTURE-SPINE AD-1). No rollback logic exists.
--
-- KEYS[1] = orders:users     (set of emails holding a confirmed order)
-- KEYS[2] = stock:remaining  (integer)
-- ARGV[1] = email            (trimmed by the route before it gets here)
--
-- Reply: { verdict, remaining } — verdict is exactly one of OK | ALREADY |
-- SOLD_OUT; remaining is the stock after this call (post-DECR on OK). Story
-- 1.6 consumes "OK with remaining == 0" to publish sale.sold_out exactly once.
--
-- Missing stock key -> error reply (fail closed, 503 at the API edge): never
-- fabricate a number — 0 would lie "sold out". A flushed Redis lost
-- orders:users too, so no honest ALREADY exists in that state either.
-- Story 1.4's cold-start rebuild makes this state unreachable.
local stock = tonumber(redis.call('GET', KEYS[2]))
if stock == nil then
  return redis.error_reply('stock:remaining missing')
end
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then
  return { 'ALREADY', stock }
end
if stock <= 0 then
  return { 'SOLD_OUT', stock }
end
redis.call('SADD', KEYS[1], ARGV[1])
return { 'OK', redis.call('DECR', KEYS[2]) }
