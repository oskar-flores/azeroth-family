# =============================================================================
#  ac-admin-ui -- the family realm's web console
# =============================================================================
#  Based on mysql:8.4 rather than a node image on purpose. backup.js shells out
#  to mysqldump, and the dump has to come from a client of the same vintage as
#  the server; what Alpine and Debian ship as "mysql-client" is MariaDB, which
#  against a MySQL 8.4 server is a caching_sha2_password and dialect gamble a
#  backup tool cannot afford to lose.
#
#  Node comes from the official tarball (glibc >= 2.28 required; this image is
#  Oracle Linux 9 with glibc 2.34). Build context is admin-ui/.
# =============================================================================
FROM mysql:8.4

ARG NODE_VERSION=22.20.0

USER root

RUN microdnf install -y tar gzip xz curl shadow-utils \
 && microdnf clean all \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 --no-same-owner \
 && node --version \
 && mysqldump --version

# Docker copies this ownership onto a fresh `ac-backups` named volume the first
# time it is mounted, which is what lets a non-root process write dumps there.
RUN useradd --system --uid 1000 --create-home --home-dir /app acadmin \
 && mkdir -p /backups \
 && chown acadmin:acadmin /backups /app

WORKDIR /app
COPY --chown=acadmin:acadmin package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=acadmin:acadmin src ./src

USER acadmin
ENV NODE_ENV=production
EXPOSE 8080

# The mysql image's entrypoint initialises a database. This image is not a
# database -- it only borrows the client tools.
ENTRYPOINT []
CMD ["node", "src/server.js"]
