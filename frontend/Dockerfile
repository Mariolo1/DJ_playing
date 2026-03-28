# ---- BUILD STAGE ----
FROM node:20-alpine AS build

WORKDIR /app

# kopiuj tylko deps (cache)
COPY package*.json ./

# używamy npm install zamiast ci (naprawia Twój problem)
RUN npm install

# kopiuj resztę kodu
COPY . .

# build args
ARG REACT_APP_API_URL
ENV REACT_APP_API_URL=$REACT_APP_API_URL

# build aplikacji
RUN npm run build


# ---- PRODUCTION STAGE ----
FROM nginx:1.27-alpine

# usuń default config
RUN rm /etc/nginx/conf.d/default.conf

# kopiuj nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# kopiuj build z node
COPY --from=build /app/build /usr/share/nginx/html

# port nginx
EXPOSE 80

# start
CMD ["nginx", "-g", "daemon off;"]