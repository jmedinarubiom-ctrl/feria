-- El comprador también recibe avisos: que su pedido va en camino,
-- que llegó, o que hubo que cancelarlo.
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS push_token text;
