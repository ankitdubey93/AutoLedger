# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv
#
# That check flags VITE_DEMO_PASSWORD. It is not a secret: it is the public
# demo account's password, inlined into the shipped JavaScript on purpose so
# the sign-in page can offer the demo. Never pass a real credential here.
#
# Vite inlines VITE_* variables at build time, so the API URL (and the
# optional demo credentials) are build arguments, not runtime environment.
# The result is static files served by nginx with an SPA fallback.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_API_BASE_URL=http://localhost:5000
ARG VITE_DEMO_EMAIL=
ARG VITE_DEMO_PASSWORD=
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL \
    VITE_DEMO_EMAIL=$VITE_DEMO_EMAIL \
    VITE_DEMO_PASSWORD=$VITE_DEMO_PASSWORD
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
