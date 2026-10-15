# Build the source-pinned local base with ./build.sh before composing.
FROM kundexa-docuseal-upstream:3c65b0e4ba872fe71d5566c0d09c3ace59a7fb8a
COPY overlay/app/controllers/api/kundexa_templates_controller.rb /app/app/controllers/api/kundexa_templates_controller.rb
COPY overlay/config/initializers/kundexa_isolated_templates.rb /app/config/initializers/kundexa_isolated_templates.rb
