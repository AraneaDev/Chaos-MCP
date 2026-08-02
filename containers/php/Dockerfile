FROM composer:2.8.10@sha256:20462d70afcfa999ad75dbd9333194067f4d869078bdb37430339e8d97e541d6 AS composer

FROM php:8.4.10-cli-bookworm@sha256:1aede5b0c2f414ea0ad5e746f2c5315008ea1b342bcf369f51ddb7a481802505

ARG XDEBUG_VERSION=3.5.3

# procps supplies `ps`, absent from the slim base but a POSIX baseline that test
# tooling assumes; its absence broke StrykerJS in the TypeScript image and the
# same class of failure is open to any suite these sandboxes run.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      git unzip procps $PHPIZE_DEPS \
    && pecl install "xdebug-${XDEBUG_VERSION}" \
    && docker-php-ext-enable xdebug \
    && apt-get purge --yes --auto-remove $PHPIZE_DEPS \
    && rm -rf /var/lib/apt/lists/*

COPY --from=composer /usr/bin/composer /usr/local/bin/composer

COPY containers/php/composer.json containers/php/composer.lock /opt/chaos-composer/

ENV COMPOSER_ALLOW_SUPERUSER=1
RUN cd /opt/chaos-composer \
    && composer install --no-dev --no-interaction --no-progress --prefer-dist \
      --classmap-authoritative \
    && ln -s /opt/chaos-composer/vendor/bin/infection /usr/local/bin/infection \
    && chmod -R a+rX /opt/chaos-composer

LABEL org.opencontainers.image.source="https://github.com/AraneaDev/Chaos-MCP" \
      org.opencontainers.image.description="Pinned PHP mutation runner for Chaos-MCP"

WORKDIR /workspace
CMD ["sh", "-c", "while :; do sleep 3600; done"]
