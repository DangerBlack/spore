# The gate: the page people open to browse and publish.
#
# This is almost certainly the one you want. It serves the static bundle over
# HTTP; it does not seed anything and holds no content of its own. To keep a
# published site reachable when nobody has a tab open, see deploy/seeder/.
#
# There is no build step to run here, and that is deliberate rather than an
# omission — the gate is plain files so that anyone can mirror it. This image
# only copies them in front of a web server.
FROM nginx:1.27-alpine

COPY deploy/gate/nginx.conf /etc/nginx/conf.d/default.conf

# Only the bundle. tools/, deploy/ and the repository's own docs are not part
# of what a reader needs, and shipping less is one fewer thing to get wrong.
WORKDIR /usr/share/nginx/html
# relay.html is only used with CONTENT_ISOLATION on (js/config.js); with it off
# it refuses to do anything, so it is always shipped rather than conditionally.
COPY index.html app.css sw.js relay.html ./
COPY js/ ./js/
COPY vendor/ ./vendor/
COPY example-site/ ./example-site/

EXPOSE 80
