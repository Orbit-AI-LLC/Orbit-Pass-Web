/* What vectors/import/expected.json records about each imported item: the
   item without its timestamps. OrbitPassKit's ImportTests compare the same. */
export function project(item) {
  const out = { type: item.type, title: item.title, favorite: item.favorite, notes: item.notes, tags: item.tags, fields: item.fields };
  if (item.type === "login") out.login = { username: item.login.username, password: item.login.password, urls: item.login.urls, totp: item.login.totp };
  if (item.type === "card") out.card = { cardholder: item.card.cardholder, number: item.card.number, expMonth: item.card.expMonth, expYear: item.card.expYear, cvv: item.card.cvv, brand: item.card.brand };
  if (item.type === "identity") out.identity = { ...item.identity };
  return out;
}
