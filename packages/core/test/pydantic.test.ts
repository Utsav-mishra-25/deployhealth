import { describe, expect, it } from 'vitest';
import { logicalLines, scanPydanticSettings } from '../src/pydantic';
import { scanSource } from '../src/scanner';

/** `NAME` or `NAME?` (has a default), in source order. */
const fields = (source: string) => scanPydanticSettings(source, 'settings.py').map((r) => `${r.name}${r.hasDefault ? '?' : ''}`);

describe('logicalLines', () => {
  it('joins lines inside brackets, triple-quoted strings and after a backslash, and drops comments', () => {
    const source = ['x: int = Field(  # a comment', '    default=1,', ')', '"""doc', 'string"""', 'y = 1 + \\', '    2', '', '# only a comment', 'z = "#not a comment"'].join('\n');
    expect(logicalLines(source)).toEqual([
      { line: 1, indent: 0, code: 'x: int = Field( default=1, )' },
      { line: 4, indent: 0, code: '"""doc string"""' },
      { line: 6, indent: 0, code: 'y = 1 + 2' },
      { line: 10, indent: 0, code: 'z = "#not a comment"' },
    ]);
  });
});

describe('scanPydanticSettings', () => {
  it('reads each annotated field of a BaseSettings class as the env var NAME uppercased', () => {
    const source = `
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    """Settings.

    database_url: documented here, not a field
    """

    database_url: str
    port: int = 8000
    debug: bool = False
    API_TOKEN: str

    @field_validator("database_url")
    @classmethod
    def check(cls, value: str) -> str:
        local: int = 1
        return value

    @computed_field
    @property
    def dsn(self) -> str:
        return self.database_url
`;
    expect(fields(source)).toEqual(['DATABASE_URL', 'PORT?', 'DEBUG?', 'API_TOKEN']);
    expect(scanPydanticSettings(source, 'app/settings.py')[0]).toEqual({ name: 'DATABASE_URL', file: 'app/settings.py', line: 10, column: 5, syntax: 'BaseSettings' });
  });

  it('prepends a literal env_prefix from model_config, class Config or a class keyword, and inherits it in this file', () => {
    const v2 = `
class AppSettings(pydantic_settings.BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="APP_",
    )
    name: str

class Worker(AppSettings):
    concurrency: int
`;
    expect(fields(v2)).toEqual(['APP_NAME', 'APP_CONCURRENCY']);
    const v1 = `
class Settings(BaseSettings):
    redis_url: str

    class Config:
        env_prefix = 'cache_'
`;
    expect(fields(v1)).toEqual(['CACHE_REDIS_URL']);
    expect(fields('class S(BaseSettings, env_prefix="SVC_"):\n    host: str\n')).toEqual(['SVC_HOST']);
    expect(fields('class S(BaseSettings):\n    model_config = SettingsConfigDict(case_sensitive=True, env_prefix="App_")\n    host_Name: str\n')).toEqual(['App_host_Name']);
  });

  it('counts = value, Field(default=...), Field(value) and default_factory as defaults; Field(...) and Field(description=...) are required', () => {
    const source = `
class Settings(BaseSettings):
    a: int = 1
    b: str = Field(default="x", description="b")
    c: str = Field("x")
    d: list[str] = Field(default_factory=list)
    e: str = Field(...)
    f: str = Field(description="no default")
    g: str = Field(
        description="multi-line, still read as one line",
        default="g",
    )
    h: dict[str, int] = {"a": 1}
`;
    expect(fields(source)).toEqual(['A?', 'B?', 'C?', 'D?', 'E', 'F', 'G?', 'H?']);
  });

  it('counts a None default only when the type allows None', () => {
    const source = `
class Settings(BaseSettings):
    a: Optional[str] = None
    b: str | None = None
    c: Union[str, None] = None
    d: typing.Optional[int] = Field(default=None, description="d")
    e: str | None = Field(None)
    f: str = None
    g: str = Field(default=None)
    h: str | None
`;
    expect(fields(source)).toEqual(['A?', 'B?', 'C?', 'D?', 'E?', 'F', 'G', 'H']);
  });

  it('skips ClassVar, private names, model_config and fields typed as a model from this file', () => {
    const source = `
class Database(BaseModel):
    host: str

class Cache(BaseSettings):
    url: str

class Settings(BaseSettings):
    model_config: ClassVar[SettingsConfigDict] = SettingsConfigDict()
    registry: ClassVar[dict] = {}
    _secret: str
    database: Database
    cache: Cache | None = None
    level: LogLevel = LogLevel.INFO
`;
    expect(fields(source)).toEqual(['URL', 'LEVEL?']);
  });

  it('reads aliases instead of the field name: alias=, validation_alias=, env= and AliasChoices (each one optional)', () => {
    const source = `
class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="APP_")
    key: str = Field(alias="STRIPE_KEY")
    url: str = Field(validation_alias="redis_url", default="redis://")
    token: str = Field(..., env="LEGACY_TOKEN")
    files_url: str = Field(validation_alias=AliasChoices("FILES_URL", "CONSOLE_API_URL"))
    dynamic: str = Field(alias=SOME_CONSTANT)
`;
    expect(fields(source)).toEqual(['STRIPE_KEY', 'REDIS_URL?', 'LEGACY_TOKEN', 'FILES_URL?', 'CONSOLE_API_URL?', 'APP_DYNAMIC']);
  });

  it('reads multi-line class headers and same-file subclasses, and nothing from other classes', () => {
    const source = `
class Combined(
    # a comment between bases
    Base,
    BaseSettings,
):
    combined_flag: bool

class Child(Combined):
    child_value: str

class Model(BaseModel):
    not_env: str

class Plain:
    also_not_env: str
`;
    expect(fields(source)).toEqual(['COMBINED_FLAG', 'CHILD_VALUE']);
    expect(scanPydanticSettings('class Model(BaseModel):\n    x: str\n', 'm.py')).toEqual([]);
    // A base defined in another file is only known when the caller passes it.
    expect(scanPydanticSettings('class Prod(Settings):\n    replica_url: str\n', 'p.py', new Set(['Settings']))).toHaveLength(1);
  });

  it('merges with other reads on the same line in scanSource, so one line is one reference', () => {
    const source = 'class S(BaseSettings):\n    region: str = os.getenv("REGION", "eu")\n';
    expect(scanSource(source, 'python', 's.py')).toEqual([{ name: 'REGION', file: 's.py', line: 2, column: 5, syntax: 'BaseSettings', hasDefault: true }]);
  });
});
