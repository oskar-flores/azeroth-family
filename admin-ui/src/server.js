// Fastify parses JSON out of the box but not HTML form posts, and the
// dependency budget for this app is two packages, so this replaces
// @fastify/formbody.
export function formBodyParser(request, body, done) {
  try {
    done(null, Object.fromEntries(new URLSearchParams(body)));
  } catch (err) {
    done(err);
  }
}