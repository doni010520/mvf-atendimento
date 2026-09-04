import { Scroll } from "@/components/scroll";
import { listarFeedback } from "@/lib/data/feedback";
import { FeedbackBoard } from "@/components/feedback-board";

export const revalidate = 0;

/**
 * Quadro de melhorias e falhas (mesmo design do correa-atendimento).
 * Sem trava de permissão: todo mundo cria, move e vê tudo.
 */
export default async function MelhoriasPage() {
  const itens = await listarFeedback();
  return (
    <Scroll>
      <div className="mx-auto max-w-6xl">
        <FeedbackBoard itens={itens} />
      </div>
    </Scroll>
  );
}
