<?php

namespace App\Support;

use Illuminate\Support\Env;

class Helpers
{
    public function reads(): array
    {
        return [
            getenv('GETENV_VAR'),
            getenv("GETENV_OPT") ?: 'fallback',
            // getenv returns false, not null, when unset: `??` supplies nothing.
            getenv('GETENV_Q') ?? 'never',
            \getenv('GETENV_LOCAL', true),
            $_ENV['ENV_ARR'] ?? 'fallback',
            $_ENV["ENV_REQ"],
            Env::get('ENV_GET', 'a'),
            \Illuminate\Support\Env::get('ENV_GET2'),
            env('THROWS') ?: throw new \RuntimeException('THROWS is required'),
            // Not reads: a method, a static call on another class and request data.
            $this->env('NOT_A_READ'),
            Config::env('NOT_A_READ_EITHER'),
            $_SERVER['SERVER_ONLY_VAR'],
            $_SERVER['HTTP_HOST'],
        ];
    }
}
