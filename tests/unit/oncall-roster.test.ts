import { describe, it, expect, vi, afterEach } from "vitest";
import { listTechs, RosterError } from "@/lib/oncall/roster";

const config = { url: "https://db.test", serviceRoleKey: "service-role-key" };

afterEach(() => vi.unstubAllGlobals());

function mockRows(rows: unknown, status = 200) {
  const fetchMock = vi.fn(async () =>
    status === 200 ? Response.json(rows) : new Response("nope", { status })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("listTechs", () => {
  it("normalizes however the number was typed", async () => {
    mockRows([
      { id: 1, name: "Mike Alvarez", phone: "(206) 555-0134", active: true },
      { id: 2, name: "Dana Kim", phone: "206.555.0175", active: true },
    ]);
    await expect(listTechs(config)).resolves.toEqual([
      { id: "1", name: "Mike Alvarez", phone: "+12065550134", active: true },
      { id: "2", name: "Dana Kim", phone: "+12065550175", active: true },
    ]);
  });

  it("drops rows the phone line could never dial, rather than offering them", async () => {
    mockRows([
      { id: 1, name: "Mike", phone: "ask the office" },
      { id: 2, name: "", phone: "206-555-0134" },
      { id: 3, name: "Dana", phone: "206-555-0175" },
    ]);
    await expect(listTechs(config)).resolves.toEqual([
      { id: "3", name: "Dana", phone: "+12065550175", active: true },
    ]);
  });

  it("treats a missing active flag as active", async () => {
    mockRows([{ id: 1, name: "Mike", phone: "206-555-0134" }]);
    await expect(listTechs(config)).resolves.toMatchObject([{ active: true }]);
  });

  it("sends the service-role key and asks for the right columns", async () => {
    const fetchMock = mockRows([]);
    await listTechs(config);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toContain("/rest/v1/oncall_techs");
    expect(String(url)).toContain("select=id%2Cname%2Cphone%2Cactive");
    expect((init.headers as Record<string, string>).apikey).toBe("service-role-key");
  });

  it("names the missing table instead of a bare 404", async () => {
    mockRows(null, 404);
    await expect(listTechs(config)).rejects.toThrow(/oncall_techs table does not exist/);
    await expect(listTechs(config)).rejects.toBeInstanceOf(RosterError);
  });

  it("reports an unreachable database as a gateway problem", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("dns"); }));
    await expect(listTechs(config)).rejects.toMatchObject({ status: 502 });
  });
});
