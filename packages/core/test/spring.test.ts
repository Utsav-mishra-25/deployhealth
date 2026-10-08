import { describe, expect, it } from 'vitest';
import { configurationPropertiesPrefixes, envForm, isSpringConfigName, scanSpringConfig, springPlaceholders, springUsedNames, usesSpring } from '../src/spring';

describe('Spring config files', () => {
  it('are application* and bootstrap* properties and YAML, profiles included', () => {
    for (const name of ['application.properties', 'application.yml', 'application.yaml', 'application-prod.yml', 'bootstrap.properties', 'application-eu.west.yaml']) {
      expect(isSpringConfigName(name), name).toBe(true);
    }
    for (const name of ['app.yml', 'applications.yml', 'application.json', 'messages.properties', 'application.yml.bak']) expect(isSpringConfigName(name), name).toBe(false);
  });

  it("keys' env forms, as Spring's relaxed binding writes them", () => {
    expect(envForm('spring.datasource.url')).toBe('SPRING_DATASOURCE_URL');
    expect(envForm('cache.ttl-seconds')).toBe('CACHE_TTLSECONDS');
    expect(envForm('my.list[0].name')).toBe('MY_LIST_0_NAME');
    expect(envForm('app.servers[1]')).toBe('APP_SERVERS_1');
  });

  it('properties: key=value, key: value and key value; comments skipped; values never kept', () => {
    const { keyEnvNames, references } = scanSpringConfig(
      ['spring.datasource.url=jdbc:x', 'server.port: 8080', 'app.name Demo', '# commented.key=1', '! bang.key=1', 'bare.key', 'a.b=${A}'].join('\n'),
      'application.properties',
    );
    expect([...keyEnvNames].sort()).toEqual(['APP_NAME', 'A_B', 'BARE_KEY', 'SERVER_PORT', 'SPRING_DATASOURCE_URL']);
    expect(references.map((r) => r.name)).toEqual(['A']);
    expect(JSON.stringify([...keyEnvNames])).not.toMatch(/jdbc|8080|Demo/);
  });

  it('YAML: keys joined along indentation, quoted keys, block scalars and list items skipped, documents reset', () => {
    const yaml = [
      'spring:',
      '  datasource:',
      '    url: ${DB_URL}',
      '    "user-name": sa',
      '  jpa:',
      '    show-sql: true',
      'notes: |',
      '  looks.like: a key',
      '  ${IN_BLOCK}',
      'servers:',
      '  - host: a',
      '    port: 1',
      'after: 1',
      '---',
      'second:',
      '  doc: 2',
      '# a.comment: ${COMMENTED}',
    ].join('\n');
    const { keyEnvNames, references } = scanSpringConfig(yaml, 'src/main/resources/application.yml');
    expect([...keyEnvNames].sort()).toEqual([
      'AFTER',
      'NOTES',
      'SECOND',
      'SECOND_DOC',
      'SERVERS',
      'SPRING',
      'SPRING_DATASOURCE',
      'SPRING_DATASOURCE_URL',
      'SPRING_DATASOURCE_USERNAME',
      'SPRING_JPA',
      'SPRING_JPA_SHOWSQL',
    ]);
    expect(references.map((r) => `${r.name}:${r.line}`)).toEqual(['DB_URL:3', 'IN_BLOCK:9']);
  });
});

describe('springPlaceholders', () => {
  const read = (text: string, escaped = false) => springPlaceholders(text, { escaped }).map((p) => `${p.name}${p.hasDefault ? '?' : ''}`);

  it('env names only; a default, or being inside one, makes a read optional', () => {
    expect(read('${A} ${b} ${server.port} ${C:} ${D:x} ${E:${F}} ${G:${H:${I}}} ${J}')).toEqual(['A', 'C?', 'D?', 'E?', 'F?', 'G?', 'H?', 'I?', 'J']);
    expect(read('${A:${server.port}} ${B}')).toEqual(['A?', 'B']);
    expect(read('${A.B} ${A-B} ${A[0]} ${A')).toEqual([]);
  });

  it("Kotlin's escaped form", () => {
    expect(read('\\${A} ${B}', true)).toEqual(['A']);
  });
});

describe('relaxed binding', () => {
  it('a declared name is used when it is a key env form, starts with a Spring Boot prefix or a @ConfigurationProperties prefix', () => {
    const declared = ['MAIL_HOST', 'SPRING_PROFILES_ACTIVE', 'SERVER_PORT', 'MANAGEMENT_X', 'LOGGING_LEVEL_ROOT', 'APP_MAIL_SENDER', 'APP_MAILER', 'SPRING', 'SPRING_', 'OTHER', 'APP_MAIL'];
    const used = springUsedNames(declared, new Set(['MAIL_HOST']), ['APP_MAIL']);
    expect([...used].sort()).toEqual(['APP_MAIL_SENDER', 'LOGGING_LEVEL_ROOT', 'MAIL_HOST', 'MANAGEMENT_X', 'SERVER_PORT', 'SPRING_PROFILES_ACTIVE']);
  });

  it('@ConfigurationProperties prefixes in any of its forms', () => {
    const source = ['@ConfigurationProperties("app.mail")', '@ConfigurationProperties(prefix = "my-service.client")', '@ConfigurationProperties(value="x.y")', '@ConfigurationProperties'].join('\n');
    expect(configurationPropertiesPrefixes(source)).toEqual(['APP_MAIL', 'MYSERVICE_CLIENT', 'X_Y']);
  });

  it('a file uses Spring when it mentions org.springframework', () => {
    expect(usesSpring('import org.springframework.boot.SpringApplication;')).toBe(true);
    expect(usesSpring('import io.javalin.Javalin;')).toBe(false);
  });
});
