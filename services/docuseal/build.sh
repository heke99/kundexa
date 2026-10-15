#!/bin/sh
set -eu
cd "$(dirname "$0")"
docker build --tag kundexa-docuseal-upstream:3c65b0e4ba872fe71d5566c0d09c3ace59a7fb8a 'https://github.com/docusealco/docuseal.git#3c65b0e4ba872fe71d5566c0d09c3ace59a7fb8a'
docker compose build docuseal
