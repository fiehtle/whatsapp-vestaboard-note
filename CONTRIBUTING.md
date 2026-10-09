# Contributing

Use Node 24 and keep the runtime small. New installs must work without any
maintainer account, deployment, storage connection or private file.

Before a pull request:

```sh
npm ci --ignore-scripts
npm test
npm run test:coverage
npm run check:public
npm audit --omit=dev
```

Add meaningful regressions for delivery, security or formatting changes. Existing
provider seams support tests without network access. Live evals are opt-in and
billable; report the model/date and limits of any live result separately.

Use synthetic examples and reserved phone numbers. Never attach raw provider
payloads, logs, environment files, audio recordings or production screenshots.
Read SECURITY.md before changing authentication, storage, networking or CI.

Keep PRs focused. Explain the changed behavior and validation, including risks.
Changes to the public template do not automatically update anyone's private
installation. Operators should review upgrades and deploy them to their own scope.
