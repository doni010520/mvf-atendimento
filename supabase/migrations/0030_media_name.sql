-- Nome ORIGINAL do arquivo (ex.: "orcamento.xls").
-- Sem ele o atendente baixava o arquivo com o nome gerado do storage e, quando
-- o mimetype nao era conhecido, com extensao ".bin" — o Windows/Excel entao
-- recusava abrir. Guardamos o nome que o cliente enviou e usamos no download.
alter table messages add column if not exists media_name text;
