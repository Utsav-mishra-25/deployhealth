<?php

return [
    'name' => env('APP_NAME', 'Laravel'),
    'key' => env('APP_KEY'),
    'db_host' => env("DB_HOST", '127.0.0.1'),
    // A framework setting with no default (null means "not set"): never MISSING next to artisan.
    'db_url' => env('DB_URL'),
];
