#!/bin/sh
set -e

echo "Waiting for PostgreSQL at ${PG_HOST}:${PG_PORT:-5432}..."
until nc -z "${PG_HOST}" "${PG_PORT:-5432}"; do
  echo "  postgres not ready — retrying in 1s"
  sleep 1
done
echo "PostgreSQL is ready."

echo "Running migrations..."
npm run migrate

echo "Starting server..."
exec npm run dev
