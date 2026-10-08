<?php

return [
    'service' => [
        'url' => env('MY_SERVICE_URL'),
        'timeout' => env('MY_SERVICE_TIMEOUT', 30),
        // A default of null is no default.
        'flag' => env('FEATURE_FLAG', null),
        'other' => env('OTHER_FLAG', NULL) ?? 'off',
    ],
];
