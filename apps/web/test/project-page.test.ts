import type { Check } from "@deployhealth/db";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RECENT_CHECKS_SHOWN, RecentChecks } from "@/components/recent-checks";
import { projectSectionLinks, SectionLinks } from "@/components/section-links";

const check = (i: number): Check => ({
  id: i,
  endpointId: "e1",
  checkedAt: new Date(Date.UTC(2026, 9, 17, 12, 0) - i * 60_000),
  ok: i % 2 === 0,
  statusCode: i % 2 === 0 ? 200 : 503,
  latencyMs: 40 + i,
  error: i % 2 === 0 ? null : "Expected 200, got 503",
});

const rows = (html: string) =>
  (html.match(/<tbody[\s\S]*?<\/tbody>/g) ?? []).map(
    (body) => (body.match(/<tr>/g) ?? []).length,
  );

describe("recent checks", () => {
  it('shows 5 rows, the rest inside a closed "Show all checks"', () => {
    expect(RECENT_CHECKS_SHOWN).toBe(5);
    const html = renderToStaticMarkup(
      createElement(RecentChecks, {
        checks: Array.from({ length: 20 }, (_, i) => check(i)),
      }),
    );
    expect(rows(html)).toEqual([5, 15]);
    expect(html).toMatch(
      /<details[^>]*><summary[^>]*>Show all checks<\/summary>/,
    );
    expect(html).not.toMatch(/<details[^>]* open/);
  });

  it('has no "Show all checks" with 5 checks or fewer', () => {
    const html = renderToStaticMarkup(
      createElement(RecentChecks, {
        checks: Array.from({ length: 5 }, (_, i) => check(i)),
      }),
    );
    expect(rows(html)).toEqual([5]);
    expect(html).not.toContain("Show all checks");
  });
});

describe("section links", () => {
  it("follow the page order, and list only the sections the page renders", () => {
    const labels = (scanned: boolean, prChecks: boolean) =>
      projectSectionLinks({ scanned, prChecks }).map((l) => l.label);
    expect(labels(true, true)).toEqual([
      "Findings",
      "Deploys",
      "Pull requests",
      "Endpoints",
    ]);
    expect(labels(true, false)).toEqual(["Findings", "Deploys", "Endpoints"]);
    expect(labels(false, true)).toEqual(["Pull requests", "Endpoints"]);
    expect(
      projectSectionLinks({ scanned: true, prChecks: true }).map((l) => l.id),
    ).toEqual(["findings", "deploys", "pull-requests", "endpoints"]);
  });

  it("render as links to the sections, and not at all for fewer than two", () => {
    const html = renderToStaticMarkup(
      createElement(SectionLinks, {
        links: projectSectionLinks({ scanned: true, prChecks: true }),
      }),
    );
    expect([...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "#findings",
      "#deploys",
      "#pull-requests",
      "#endpoints",
    ]);
    expect(
      renderToStaticMarkup(
        createElement(SectionLinks, {
          links: projectSectionLinks({ scanned: false, prChecks: false }),
        }),
      ),
    ).toBe("");
  });
});
