# Third-party notices

DeepSonar's proprietary notice applies only to the project's original source
code. Dependencies, vendored files, command-line tools, base images, and other
third-party components remain subject to their respective license terms.

Runtime image component names, versions, sources, and license identifiers are
maintained in:

- `agent-harness/runtime-images.json`
- `agent-harness/kali-minimal-runtime.json`

Runtime image builds also generate component manifests, and the image
admission process records an SBOM for admitted images. These inventories do
not replace the license texts or notices supplied by each upstream project.

In particular, bundled artifacts may include software under MIT, BSD, Apache,
MPL, GPL, LGPL, PSF, or commercial terms. The DeepSonar authorization does not
grant rights to those components. Distributors and operators must comply with
all applicable third-party terms.

The vendored `deploy/vendor/gitcode-repo-py3` launcher retains its upstream
Apache License 2.0 header.
