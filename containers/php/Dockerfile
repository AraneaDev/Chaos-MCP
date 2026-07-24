FROM composer:2.8.10@sha256:20462d70afcfa999ad75dbd9333194067f4d869078bdb37430339e8d97e541d6 AS composer

FROM php:8.4.10-cli-bookworm@sha256:1aede5b0c2f414ea0ad5e746f2c5315008ea1b342bcf369f51ddb7a481802505

ARG INFECTION_VERSION=0.34.0

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      git unzip $PHPIZE_DEPS \
    && pecl install xdebug \
    && docker-php-ext-enable xdebug \
    && apt-get purge --yes --auto-remove $PHPIZE_DEPS \
    && rm -rf /var/lib/apt/lists/*

COPY --from=composer /usr/bin/composer /usr/local/bin/composer

ENV COMPOSER_HOME=/opt/chaos-composer
RUN composer global config --no-plugins \
      allow-plugins.infection/extension-installer true \
    && composer global require --no-interaction --no-progress \
      "infection/infection:${INFECTION_VERSION}" \
    && ln -s /opt/chaos-composer/vendor/bin/infection /usr/local/bin/infection \
    && chmod -R a+rX /opt/chaos-composer

LABEL org.opencontainers.image.source="https://github.com/AraneaDev/Chaos-MCP" \
      org.opencontainers.image.description="Pinned PHP mutation runner for Chaos-MCP"

WORKDIR /workspace
CMD ["sh", "-c", "while :; do sleep 3600; done"]
